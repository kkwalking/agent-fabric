#!/usr/bin/env bash
# Real-Docker end-to-end acceptance for the v11 hardening (spec §21–§24/§40).
#
# Drives the *real* API against a *real* Docker daemon and a *real* git remote:
#
#   Create Git Credential → Create Project → Create Task → Managed Workspace
#   → Clone Repository → Resolve Base Commit → Create Working Branch
#   → Start Real Docker Runtime → Mount Workspace → Run Fake Agent in Docker
#   → Modify Workspace → Verify the Agent Cannot Read the Git Credential
#   → Run Validation Inside a Sandbox → Finalize Git → Freeze the Final SHA
#   → Push the Exact Final Commit → Destroy the Docker Runtime
#   → Verify the Workspace Still Exists → Verify the Remote Branch
#   → Verify the Secret Never Leaked
#
# No LLM is called: the "agent" is a deterministic shell script that runs
# inside the container. Prints every step's evidence; exits non-zero on the
# first failure.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-7393}
BASE="http://127.0.0.1:$PORT"
WORK=$(mktemp -d /tmp/af-e2e-docker-XXXXXX)
IMAGE=${AGENTFABRIC_DOCKER_E2E_IMAGE:-node:22-alpine}
export AGENTFABRIC_DATA_DIR="$WORK/data"
export AGENTFABRIC_HOST=127.0.0.1
export AGENTFABRIC_PORT="$PORT"
export GIT_AUTHOR_NAME="AgentFabric E2E"
export GIT_AUTHOR_EMAIL="e2e@example.test"
export GIT_COMMITTER_NAME="AgentFabric E2E"
export GIT_COMMITTER_EMAIL="e2e@example.test"
# A host-only secret: it must never be visible inside any container.
export AGENTFABRIC_HOST_ONLY_SECRET="AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
jqr() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }
# Every /api call except /api/health presents this bearer token (the server
# writes it to $AGENTFABRIC_DATA_DIR/token on first start; read below once the
# server is up). The value is never echoed — only its path.
AUTH_TOKEN=""
acurl() { curl "$@" -H "Authorization: Bearer $AUTH_TOKEN"; }

step "preconditions: docker daemon + image $IMAGE"
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || fail "no reachable Docker daemon"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "docker image $IMAGE is not present locally"
echo "docker $(docker info --format '{{.ServerVersion}}') · image $IMAGE"

step "prepare a local bare git remote and the in-container fake agent"
mkdir -p "$WORK/seed"
git -C "$WORK/seed" init -q
git -C "$WORK/seed" symbolic-ref HEAD refs/heads/main
echo "# demo" > "$WORK/seed/README.md"
git -C "$WORK/seed" add -A
git -C "$WORK/seed" commit -qm "initial commit"
BASE_SHA=$(git -C "$WORK/seed" rev-parse HEAD)
git clone -q --bare "$WORK/seed" "$WORK/remote.git"
REMOTE="$WORK/remote.git"

mkdir -p "$WORK/skills/fake-agent"
cat > "$WORK/skills/fake-agent/run.sh" <<'AGENT'
#!/bin/sh
set -eu
echo "AF_AGENT_START"
if [ -f /.dockerenv ]; then echo "AF_IN_CONTAINER=yes"; else echo "AF_IN_CONTAINER=no"; fi
echo "AF_CONTAINER_HOSTNAME=$(hostname)"
echo "AF_CWD=$(pwd)"
echo "AF_ENV_START"
env | sort
echo "AF_ENV_END"
printf 'produced by the agent inside the container\n' > /workspace/agent-output.txt
mkdir -p /workspace/src
printf 'export const feature = 1;\n' > /workspace/src/feature.ts
echo "AF_AGENT_END"
exit 0
AGENT
chmod +x "$WORK/skills/fake-agent/run.sh"
echo "remote=$REMOTE base=$BASE_SHA"

step "start the API server"
node --import tsx packages/server/src/index.ts > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; docker rm -f $(docker ps -aq --filter "name=af-") >/dev/null 2>&1' EXIT
for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null && break
  sleep 0.5
done
curl -sf "$BASE/api/health" >/dev/null || { cat "$WORK/server.log"; fail "server did not start"; }
echo "server up: $(curl -s "$BASE/api/health")"

# The token file appears with the server's first start; wait briefly for the
# write to land, then fail loudly instead of continuing unauthenticated.
for _ in $(seq 1 50); do [ -s "$WORK/data/token" ] && break; sleep 0.1; done
AUTH_TOKEN=$(cat "$WORK/data/token" 2>/dev/null) || fail "the server did not write an API token to $WORK/data/token"
[ -n "$AUTH_TOKEN" ] || fail "the API token at $WORK/data/token is empty"
echo "api token loaded from $WORK/data/token"

step "auth: an unauthenticated /api request is refused"
UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/runtimes")
[ "$UNAUTH" = "401" ] || fail "expected 401 without a token, got $UNAUTH"
echo "unauthenticated request refused with 401"

step "AC-9/AC-12: create a git-scoped Source Credential"
TOKEN="AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK"
CRED=$(acurl -sf -X POST "$BASE/api/source-credentials" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Git\",\"type\":\"https-token\",\"username\":\"e2e\",\"value\":\"$TOKEN\"}")
CRED_ID=$(echo "$CRED" | jqr .id)
echo "credential=$CRED_ID masked=$(echo "$CRED" | jqr .secretMasked)"
acurl -s "$BASE/api/source-credentials" | grep -q "$TOKEN" && fail "the credential value was served by the API"
echo "the credential value is never served"

step "AC-9: a git-scoped secret cannot be injected into a runtime via Task secretIds"
PROJ=$(acurl -sf -X POST "$BASE/api/projects" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Docker\",\"source\":{\"remoteUrl\":\"$REMOTE\",\"credentialId\":\"$CRED_ID\",\"defaultBranch\":\"main\"},\"skills\":[{\"name\":\"fake-agent\",\"path\":\"$WORK/skills/fake-agent\"}]}")
PROJ_ID=$(echo "$PROJ" | jqr .id)
echo "project=$PROJ_ID"

step "AC-1/AC-2: a Project task on a host runtime is refused before execution"
HOST_RT=$(acurl -sf -X POST "$BASE/api/runtimes" -H 'Content-Type: application/json' \
  -d '{"name":"E2E host runtime","kind":"docker","containerized":false,"executionBackend":"host","usableInTask":true,"enabled":true}' | jqr .id)
REFUSAL=$(acurl -s -o "$WORK/refusal.json" -w '%{http_code}' -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' \
  -d "{\"instruction\":\"must be refused\",\"runtimeId\":\"$HOST_RT\"}")
REFUSAL_CODE=$(node -e "console.log(require('$WORK/refusal.json').code)")
echo "http=$REFUSAL code=$REFUSAL_CODE"
[ "$REFUSAL" = "403" ] || fail "expected 403 for a host runtime, got $REFUSAL"
[ "$REFUSAL_CODE" = "runtime-not-isolated" ] || fail "expected runtime-not-isolated, got $REFUSAL_CODE"
TASK_COUNT=$(acurl -s "$BASE/api/projects/$PROJ_ID/tasks" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
[ "$TASK_COUNT" = "0" ] || fail "a task was created despite the refusal"
echo "refused before anything was created"

step "AC-3/AC-6: create a real isolated Docker runtime (agent + validation image)"
RT=$(acurl -sf -X POST "$BASE/api/runtimes" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Docker runtime\",\"kind\":\"docker\",\"containerized\":true,\"executionBackend\":\"isolated\",\"image\":\"$IMAGE\",\"command\":[\"sh\",\"/root/.agentfabric/skills/fake-agent/run.sh\"],\"usableInTask\":true,\"enabled\":true,\"ephemeral\":true,\"config\":{\"mountPath\":\"/workspace\"}}" | jqr .id)
echo "runtime=$RT isolation=$(acurl -s "$BASE/api/runtimes/$RT/isolation")"

step "create the Project task (managed workspace → clone → branch → Docker runtime)"
# The validation steps are built as a JSON document (nested quoting in a
# shell string is a trap); each step is a repository-driven command, i.e.
# untrusted code, which is exactly why it must run in the sandbox.
VALIDATION=$(node -e '
  const steps = [
    { name: "workspace-visible", command: "test -f /workspace/agent-output.txt" },
    { name: "agent-work-visible", command: "grep -q \"export const feature\" /workspace/src/feature.ts" },
    { name: "in-container", command: "test -f /.dockerenv" },
    { name: "environment-dump", command: "printenv | sort" },
    { name: "no-docker-socket", command: "test ! -e /var/run/docker.sock" },
    { name: "no-host-home", command: "test ! -e /Users" },
    { name: "validation-marker", command: "test \"$AGENTFABRIC_VALIDATION\" = 1" },
  ];
  console.log(JSON.stringify({ steps }));
')
START=$(node -e '
  const body = {
    instruction: "Produce the feature module",
    runtimeId: process.argv[1],
    baseRef: "main",
    validation: JSON.parse(process.argv[2]),
  };
  console.log(JSON.stringify(body));
' "$RT" "$VALIDATION" | acurl -sf -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' -d @-)
TASK_ID=$(echo "$START" | jqr .task.id)
RUN_ID=$(echo "$START" | jqr .run.id)
WS_PATH=$(echo "$START" | jqr .workspace.path)
echo "task=$TASK_ID run=$RUN_ID workspace=$WS_PATH"
[ -d "$WS_PATH/.git" ] || fail "the managed workspace was not cloned"

step "wait for the lifecycle to finish"
for _ in $(seq 1 240); do
  DETAIL=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail")
  STATUS=$(echo "$DETAIL" | jqr .status)
  case "$STATUS" in completed|failed|cancelled) break;; esac
  sleep 0.5
done
echo "$DETAIL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
console.log('phase          :',d.phase);
console.log('status         :',d.status);
console.log('isolation      :',d.isolation&&d.isolation.executionBackend,d.isolation&&d.isolation.sandboxed);
console.log('baseCommit     :',d.baseCommitSha);
console.log('branch         :',d.workingBranch);
console.log('agent          :',d.agent&&d.agent.status);
console.log('validation     :',d.validation.status,'via',d.validation.execution&&d.validation.execution.image,'in container:',d.validation.execution&&d.validation.execution.containerized);
console.log('finalization   :',d.stages&&d.stages.finalization&&d.stages.finalization.status);
console.log('publish        :',d.publish.status,d.publish.remoteBranch);
console.log('frozenRevision :',d.frozenRevision&&d.frozenRevision.finalCommitSha);
})"
[ "$STATUS" = "completed" ] || { echo "$DETAIL"; tail -40 "$WORK/server.log"; fail "task did not complete (status=$STATUS)"; }

step "AC-30/AC-3: the agent really ran inside a Docker container"
# `/logs` is plain text (one line per log/shell-output/agent-message event).
AGENT_LINES=$(acurl -s "$BASE/api/runs/$RUN_ID/logs")
echo "$AGENT_LINES" | grep -q "AF_IN_CONTAINER=yes" || fail "the agent did not run inside a container"
AGENT_HOST=$(echo "$AGENT_LINES" | sed -n 's/^.*AF_CONTAINER_HOSTNAME=\(.*\)$/\1/p' | head -1)
[ -n "$AGENT_HOST" ] || fail "the agent did not report a container hostname"
[ "$AGENT_HOST" != "$(hostname)" ] || fail "the agent hostname matches the AgentFabric host"
echo "$AGENT_LINES" | grep -q "AF_CWD=/workspace" || fail "the agent's cwd was not the mounted workspace"
echo "container hostname=$AGENT_HOST host=$(hostname) cwd=/workspace"

step "AC-31: the container's writes landed on the host workspace"
[ -f "$WS_PATH/agent-output.txt" ] || fail "the agent's file did not reach the workspace"
grep -q "produced by the agent inside the container" "$WS_PATH/agent-output.txt" || fail "wrong file content"
[ -f "$WS_PATH/src/feature.ts" ] || fail "the agent's source file did not reach the workspace"
echo "workspace carries the container's work"

step "AC-4/AC-32: the runtime container was destroyed, the workspace was not"
CONTAINER="af-$RUN_ID"
REMAINING=$(docker ps -a --filter "name=^/${CONTAINER}$" --format '{{.ID}}')
[ -z "$REMAINING" ] || fail "the container $CONTAINER still exists"
[ -d "$WS_PATH" ] || fail "the workspace disappeared with the container"
[ -d "$WS_PATH/.git" ] || fail "the workspace is no longer a git repository"
echo "container $CONTAINER is gone; workspace $WS_PATH survives"

step "AC-33/AC-5/AC-6/AC-7/AC-8: validation ran in a disposable isolated sandbox"
echo "$DETAIL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
for (const st of d.validation.steps) console.log('  ',st.status.padEnd(7),st.name);
})"
FAILED_STEPS=$(echo "$DETAIL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(d.validation.steps.filter(x=>x.status!=='passed').map(x=>x.name).join(','))})")
[ -z "$FAILED_STEPS" ] || fail "validation steps failed: $FAILED_STEPS"
VALIDATION_CONTAINERS=$(docker ps -a --filter "label=agentfabric.validation=true" --format '{{.ID}}')
[ -z "$VALIDATION_CONTAINERS" ] || fail "a disposable validation container was left behind"
VALIDATION_ENV=$(echo "$DETAIL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);const st=d.validation.steps.find(x=>x.name==='environment-dump');console.log(st?st.output:'')})")
echo "$VALIDATION_ENV" | grep -q "^AGENTFABRIC_VALIDATION=1$" || fail "the validation allowlist marker is missing"
echo "$VALIDATION_ENV" | grep -q "$TOKEN" && fail "the git credential reached the validation sandbox"
echo "$VALIDATION_ENV" | grep -q "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK" && fail "a host-only secret reached the validation sandbox"
echo "$VALIDATION_ENV" | grep -q "^GIT_ASKPASS=" && fail "a git credential helper env reached the validation sandbox"
echo "validation ran isolated, with an allowlisted environment"

step "AC-34: the Git credential never entered the agent container"
AGENT_ENV=$(echo "$AGENT_LINES" | sed -n '/AF_ENV_START/,/AF_ENV_END/p')
echo "$AGENT_ENV" | grep -q "$TOKEN" && fail "the git credential reached the agent container"
echo "$AGENT_ENV" | grep -q "AGENTFABRIC_HOST_ONLY_DO_NOT_LEAK" && fail "a host-only secret reached the agent container"
echo "$AGENT_ENV" | grep -q "^AGENTFABRIC_GIT_PASSWORD=" && fail "the git password env reached the agent container"
echo "$AGENT_ENV" | grep -q "^GIT_ASKPASS=" && fail "the askpass helper reached the agent container"
echo "$AGENT_ENV" | grep -q "^SSH_ASKPASS=" && fail "the ssh askpass helper reached the agent container"
echo "the agent container's environment carries no credential"

step "AC-17/AC-18/AC-35: the frozen revision is exactly what was pushed"
BRANCH=$(echo "$DETAIL" | jqr .workingBranch)
FROZEN=$(echo "$DETAIL" | jqr .frozenRevision.finalCommitSha)
PUBLISHED=$(echo "$DETAIL" | jqr .publish.finalCommitSha)
REMOTE_SHA=$(git --git-dir="$REMOTE" rev-parse "refs/heads/$BRANCH")
echo "branch=$BRANCH frozen=$FROZEN published=$PUBLISHED remote=$REMOTE_SHA"
[ "$FROZEN" = "$PUBLISHED" ] || fail "the published commit is not the frozen revision"
[ "$FROZEN" = "$REMOTE_SHA" ] || fail "the remote branch does not carry the frozen revision"
git --git-dir="$REMOTE" ls-tree -r --name-only "$BRANCH" | grep -q "agent-output.txt" || fail "the container's file was not published"
git --git-dir="$REMOTE" ls-tree -r --name-only "$BRANCH" | grep -q "src/feature.ts" || fail "the container's source file was not published"
[ -z "$(git --git-dir="$REMOTE" tag --list)" ] || fail "a tag was published"
echo "the exact frozen commit is on the remote branch, no tags"

step "AC-21/AC-22/AC-23: retry publish re-pushes the frozen revision, nothing else"
BEFORE_RUNS=$(acurl -s "$BASE/api/runs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(r=>r.taskId==='$TASK_ID').length))")
acurl -sf -X POST "$BASE/api/tasks/$TASK_ID/retry-publish" >/dev/null
AFTER_RUNS=$(acurl -s "$BASE/api/runs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(r=>r.taskId==='$TASK_ID').length))")
AFTER=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail")
[ "$BEFORE_RUNS" = "$AFTER_RUNS" ] || fail "retry publish created a new run"
[ "$(echo "$AFTER" | jqr .frozenRevision.finalCommitSha)" = "$FROZEN" ] || fail "the frozen revision changed on retry publish"
[ "$(echo "$AFTER" | jqr .agent.status)" = "completed" ] || fail "retry publish disturbed the agent stage"
[ "$(echo "$AFTER" | jqr .validation.status)" = "passed" ] || fail "retry publish disturbed the validation stage"
echo "runs before=$BEFORE_RUNS after=$AFTER_RUNS frozen=$FROZEN unchanged"

step "AC-24: workspace changes after finalization are never silently published"
echo "drift" > "$WS_PATH/drift.txt"
DRIFT=$(acurl -sf -X POST "$BASE/api/tasks/$TASK_ID/retry-publish")
DRIFT_CODE=$(echo "$DRIFT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s);console.log(t.execution.failure?t.execution.failure.code:'none')})")
echo "retry publish after drift → $DRIFT_CODE"
[ "$DRIFT_CODE" = "workspace-diverged-after-finalization" ] || fail "expected workspace-diverged-after-finalization, got $DRIFT_CODE"
git --git-dir="$REMOTE" ls-tree -r --name-only "$BRANCH" | grep -q "drift.txt" && fail "the drifted file was published"
[ "$(git --git-dir="$REMOTE" rev-parse "refs/heads/$BRANCH")" = "$FROZEN" ] || fail "the remote branch moved"
rm -f "$WS_PATH/drift.txt"
echo "the drift was reported, not published"

step "AC-29: the refusal names the right next action, and retry publish then succeeds"
REFUSED=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail")
[ "$(echo "$REFUSED" | jqr .retry.kind)" = "publish" ] || fail "the refusal did not offer retry publish"
[ "$(echo "$REFUSED" | jqr .retry.publish)" = "true" ] || fail "retry publish was not offered"
[ "$(echo "$REFUSED" | jqr .retry.agent)" = "false" ] || fail "retry agent was wrongly offered"
[ "$(echo "$REFUSED" | jqr .agent.status)" = "completed" ] || fail "the agent stage was disturbed"
[ "$(echo "$REFUSED" | jqr .validation.status)" = "passed" ] || fail "the validation stage was disturbed"
acurl -sf -X POST "$BASE/api/tasks/$TASK_ID/retry-publish" >/dev/null
RECOVERED_DETAIL=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail")
[ "$(echo "$RECOVERED_DETAIL" | jqr .status)" = "completed" ] || fail "retry publish did not complete after the workspace was restored"
[ "$(echo "$RECOVERED_DETAIL" | jqr .frozenRevision.finalCommitSha)" = "$FROZEN" ] || fail "the frozen revision changed"
echo "retry publish offered and succeeded; frozen revision still $FROZEN"

step "AC-15/AC-16: the credential never leaked anywhere"
grep -rq "$TOKEN" "$WS_PATH" 2>/dev/null && fail "the credential was found in the workspace"
grep -q "$TOKEN" "$WORK/server.log" && fail "the credential was found in the server log"
grep -rq "$TOKEN" "$WORK/data/events" 2>/dev/null && fail "the credential was found in the event log"
grep -q "$AUTH_TOKEN" "$WORK/server.log" && fail "the API token was printed in the server log"
node -e "
  const fs=require('fs');
  const db=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  const stored=JSON.stringify(db.secrets??[]);
  if(stored.includes(process.argv[2])){console.error('the credential is stored in plaintext');process.exit(1);}
  if(!stored.includes('enc:v1:')){console.error('the credential is missing from the (encrypted) secret store');process.exit(1);}
  if(JSON.stringify(db).includes(process.argv[2])){console.error('the credential leaked into another collection');process.exit(1);}
" "$WORK/data/db.json" "$TOKEN" || fail "the credential leaked outside the secret store"
grep -q "$TOKEN" "$WS_PATH/.git/config" && fail "the credential was found in .git/config"
grep -q "url = $REMOTE" "$WS_PATH/.git/config" || fail "the remote URL is not credential-free"
[ -z "$(ls -A "$WORK/data/git-credentials" 2>/dev/null)" ] || fail "temporary credential material was left behind"
echo "no credential material anywhere"

step "AC-27/AC-28/AC-36: the stage record is monotonic across the whole lifecycle"
RECOVERED=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
console.log('agent='+d.stages.agent.status,'validation='+d.stages.validation.status,'finalization='+d.stages.finalization.status,'publish='+d.stages.publish.status);})")
echo "$RECOVERED"
[ "$RECOVERED" = "agent=completed validation=completed finalization=completed publish=completed" ] || fail "stage record is not monotonic: $RECOVERED"

step "CLI surface: af tasks detail / af projects show"
CLI="node --import tsx packages/cli/src/index.ts --api $BASE"
$CLI tasks detail "$TASK_ID" || fail "af tasks detail failed"
$CLI projects show "$PROJ_ID" || fail "af projects show failed"

step "ALL DOCKER E2E CHECKS PASSED"
echo "work dir: $WORK"
