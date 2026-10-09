#!/usr/bin/env bash
# End-to-end verification of the v11 Project task lifecycle against a real
# server, a real git remote (a local bare repository) and the real API/CLI
# surface. Prints every step's evidence; exits non-zero on the first failure.
#
# Requires: git, a reachable Docker daemon, and the validation image below
# (validation commands are untrusted code and always run in an isolated
# runtime — see scripts/e2e-v11-docker.sh for the full real-Docker E2E).
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-7391}
BASE="http://127.0.0.1:$PORT"
# Image the disposable validation sandbox runs (v11 hardening §6).
IMAGE=${AGENTFABRIC_VALIDATION_IMAGE:-node:22-alpine}
WORK=$(mktemp -d /tmp/af-e2e-XXXXXX)
export AGENTFABRIC_DATA_DIR="$WORK/data"
export AGENTFABRIC_HOST=127.0.0.1
export AGENTFABRIC_PORT="$PORT"
export GIT_AUTHOR_NAME="AgentFabric E2E"
export GIT_AUTHOR_EMAIL="e2e@example.test"
export GIT_COMMITTER_NAME="AgentFabric E2E"
export GIT_COMMITTER_EMAIL="e2e@example.test"

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
jqr() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval('j'+process.argv[1]))})" "$1"; }
# Every /api call except /api/health presents this bearer token (the server
# writes it to $AGENTFABRIC_DATA_DIR/token on first start; read below once the
# server is up). The value is never echoed — only its path.
AUTH_TOKEN=""
acurl() { curl "$@" -H "Authorization: Bearer $AUTH_TOKEN"; }
# The credential value must not appear anywhere in db.json at all: the Secret
# store keeps it encrypted (AES-256-GCM, `enc:v1:`), and every other collection
# (tasks / runs / projects / …) must hold no copy. The value being *usable* is
# proven by the lifecycle itself (clone / push succeed with it).
assert_token_confined() {
  local token="$1" file="$2"
  node -e "
    const fs=require('fs');
    const db=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const stored=JSON.stringify(db.secrets??[]);
    if (stored.includes(process.argv[2])) {
      console.error('the credential is stored in plaintext — secrets must be encrypted at rest');
      process.exit(1);
    }
    if (!stored.includes('enc:v1:')) {
      console.error('the credential is missing from the (encrypted) secret store');
      process.exit(1);
    }
    if (JSON.stringify(db).includes(process.argv[2])) {
      console.error('the credential leaked into another collection');
      process.exit(1);
    }
    console.log('credential stored encrypted and confined to the secret store');
  " "$file" "$token"
}

step "preconditions: docker daemon + validation image $IMAGE"
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || fail "no reachable Docker daemon (validation runs in an isolated runtime)"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "docker image $IMAGE is not present locally"
echo "docker $(docker info --format '{{.ServerVersion}}') · image $IMAGE"

step "prepare a local bare git remote"
mkdir -p "$WORK/seed"
git -C "$WORK/seed" init -q
git -C "$WORK/seed" symbolic-ref HEAD refs/heads/main
echo "# demo" > "$WORK/seed/README.md"
git -C "$WORK/seed" add -A
git -C "$WORK/seed" commit -qm "initial commit"
BASE_SHA=$(git -C "$WORK/seed" rev-parse HEAD)
git clone -q --bare "$WORK/seed" "$WORK/remote.git"
REMOTE="$WORK/remote.git"
echo "remote=$REMOTE base=$BASE_SHA"

step "start the API server"
node --import tsx packages/server/src/index.ts > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
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

step "AC-2: create a Source Credential (HTTPS token)"
TOKEN="ghp_e2e_supersecrettoken"
CRED=$(acurl -sf -X POST "$BASE/api/source-credentials" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E GitHub\",\"type\":\"https-token\",\"host\":\"github.com\",\"username\":\"e2e\",\"value\":\"$TOKEN\"}")
CRED_ID=$(echo "$CRED" | jqr .id)
echo "credential=$CRED_ID masked=$(echo "$CRED" | jqr .secretMasked)"
# The value must never be served back.
if acurl -s "$BASE/api/source-credentials" | grep -q "$TOKEN"; then fail "credential value leaked in the list API"; fi
assert_token_confined "$TOKEN" "$WORK/data/db.json" || fail "credential value leaked outside the secret store"
echo "credential value is not served by the API"

step "AC-1/AC-3: create a Project on a public repository (no credential)"
PROJ=$(acurl -sf -X POST "$BASE/api/projects" -H 'Content-Type: application/json' \
  -d "{\"name\":\"E2E Demo\",\"source\":{\"remoteUrl\":\"$REMOTE\",\"defaultBranch\":\"main\"},\"validation\":{\"steps\":[{\"name\":\"readme\",\"command\":\"test -f README.md\"}]}}")
PROJ_ID=$(echo "$PROJ" | jqr .id)
echo "project=$PROJ_ID provider=$(echo "$PROJ" | jqr .source.provider)"

step "make a runtime usable for tasks (the mock harness)"
RT=$(acurl -s "$BASE/api/runtimes" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s).find(x=>x.kind==='mock');console.log(r.id)})")
acurl -sf -X PUT "$BASE/api/runtimes/$RT" -H 'Content-Type: application/json' -d '{"usableInTask":true}' >/dev/null
echo "runtime=$RT"

step "AC-1/AC-2: the mock runtime is a HOST runtime — a Project task on it is refused"
REFUSED=$(acurl -s -o "$WORK/refused.json" -w '%{http_code}' -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' \
  -d "{\"instruction\":\"refused\",\"runtimeId\":\"$RT\"}")
REFUSED_CODE=$(node -e "console.log(require('$WORK/refused.json').code)")
echo "http=$REFUSED code=$REFUSED_CODE"
[ "$REFUSED" = "403" ] || fail "expected 403 for a host runtime, got $REFUSED"
[ "$REFUSED_CODE" = "runtime-not-isolated" ] || fail "expected runtime-not-isolated, got $REFUSED_CODE"
[ "$(acurl -s "$BASE/api/projects/$PROJ_ID/tasks" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")" = "0" ] \
  || fail "a task was created despite the isolation refusal"

step "AC-2: declare the mock runtime isolated, with a real image for the validation sandbox"
# The agent harness stays scripted (the mock adapter does not spawn a
# container), but Validation is untrusted code and must genuinely run in an
# isolated runtime — so the image named here has to exist locally. This is
# the honest consequence of the hardening: this suite now needs Docker.
acurl -sf -X PUT "$BASE/api/runtimes/$RT" -H 'Content-Type: application/json' \
  -d "{\"usableInTask\":true,\"executionBackend\":\"isolated\",\"containerized\":true,\"image\":\"$IMAGE\"}" >/dev/null
echo "isolation=$(acurl -s "$BASE/api/runtimes/$RT/isolation")"

step "AC-4..AC-13: start a Project task (managed workspace → clone → branch → runtime → agent → validation → finalize → push)"
START=$(acurl -sf -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' \
  -d "{\"instruction\":\"Add a project model\",\"runtimeId\":\"$RT\",\"baseRef\":\"main\"}")
TASK_ID=$(echo "$START" | jqr .task.id)
RUN_ID=$(echo "$START" | jqr .run.id)
WS_PATH=$(echo "$START" | jqr .workspace.path)
echo "task=$TASK_ID run=$RUN_ID workspace=$WS_PATH"
[ -d "$WS_PATH" ] || fail "managed workspace directory was not created"
[ -d "$WS_PATH/.git" ] || fail "the workspace was not cloned"

step "wait for the lifecycle to finish"
STATUS=""
for _ in $(seq 1 120); do
  DETAIL=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail")
  STATUS=$(echo "$DETAIL" | jqr .status)
  case "$STATUS" in completed|failed|cancelled) break;; esac
  sleep 0.5
done
echo "$DETAIL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);
console.log('phase      :',d.phase);
console.log('status     :',d.status);
console.log('baseRef    :',d.baseRef);
console.log('baseCommit :',d.baseCommitSha);
console.log('branch     :',d.workingBranch);
console.log('agent      :',d.agent&&d.agent.status);
console.log('validation :',d.validation.status);
console.log('publish    :',d.publish.status,d.publish.remoteBranch);
console.log('finalCommit:',d.publish.finalCommitSha);
})"
[ "$STATUS" = "completed" ] || { echo "$DETAIL"; cat "$WORK/server.log" | tail -30; fail "task did not complete (status=$STATUS)"; }

step "AC-9/AC-22: base commit and final commit recorded, remote branch pushed"
[ "$(echo "$DETAIL" | jqr .baseCommitSha)" = "$BASE_SHA" ] || fail "baseCommitSha mismatch"
BRANCH=$(echo "$DETAIL" | jqr .workingBranch)
FINAL=$(echo "$DETAIL" | jqr .publish.finalCommitSha)
REMOTE_SHA=$(git --git-dir="$REMOTE" rev-parse "refs/heads/$BRANCH")
echo "branch=$BRANCH final=$FINAL remote=$REMOTE_SHA"
[ "$FINAL" = "$REMOTE_SHA" ] || fail "the remote branch does not carry the final commit"

step "AC-17: the credential never reaches the workspace, .git/config, logs or events"
if grep -rq "$TOKEN" "$WS_PATH" 2>/dev/null; then fail "credential found in the workspace"; fi
assert_token_confined "$TOKEN" "$WORK/data/db.json" || fail "credential leaked outside the secret store"
if grep -q "$TOKEN" "$WORK/server.log"; then fail "credential found in the server log"; fi
if grep -rq "$TOKEN" "$WORK/data/events" 2>/dev/null; then fail "credential found in the event log"; fi
if grep -q "$AUTH_TOKEN" "$WORK/server.log"; then fail "the API token was printed in the server log"; fi
echo "no credential material anywhere"

step "AC-14/AC-15: the workspace survives and a second run reuses it"
RETRY=$(acurl -sf -X POST "$BASE/api/tasks/$TASK_ID/retry-run" -H 'Content-Type: application/json' -d '{}')
RETRY_RUN=$(echo "$RETRY" | jqr .run.id)
for _ in $(seq 1 120); do
  STATUS=$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail" | jqr .status)
  case "$STATUS" in completed|failed|cancelled) break;; esac
  sleep 0.5
done
[ "$STATUS" = "completed" ] || fail "the retried run did not complete"
[ -d "$WS_PATH" ] || fail "the workspace disappeared after the second run"
RUNS=$(acurl -s "$BASE/api/tasks/$TASK_ID/runs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
echo "runs on the task: $RUNS (workspace reused: $WS_PATH)"

step "AC-24/AC-25: retry publish does not re-run the agent"
BEFORE=$(acurl -s "$BASE/api/runs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(r=>r.taskId==='$TASK_ID').length))")
acurl -sf -X POST "$BASE/api/tasks/$TASK_ID/retry-publish" >/dev/null
AFTER=$(acurl -s "$BASE/api/runs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(r=>r.taskId==='$TASK_ID').length))")
echo "runs before=$BEFORE after=$AFTER"
[ "$BEFORE" = "$AFTER" ] || fail "retry publish started a new run"
[ "$(acurl -sf "$BASE/api/tasks/$TASK_ID/detail" | jqr .publish.status)" = "pushed" ] || fail "retry publish did not report success"

step "AC-26: two tasks on the same project are isolated"
A=$(acurl -sf -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' -d "{\"instruction\":\"Task A\",\"runtimeId\":\"$RT\",\"workingBranch\":\"af/e2e-a\"}")
B=$(acurl -sf -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' -d "{\"instruction\":\"Task B\",\"runtimeId\":\"$RT\",\"workingBranch\":\"af/e2e-b\"}")
A_ID=$(echo "$A" | jqr .task.id); B_ID=$(echo "$B" | jqr .task.id)
A_WS=$(echo "$A" | jqr .workspace.path); B_WS=$(echo "$B" | jqr .workspace.path)
for _ in $(seq 1 160); do
  SA=$(acurl -sf "$BASE/api/tasks/$A_ID/detail" | jqr .status)
  SB=$(acurl -sf "$BASE/api/tasks/$B_ID/detail" | jqr .status)
  case "$SA$SB" in *preparing*|*running*|*validating*|*finalizing*|*publishing*) sleep 0.5;; *) break;; esac
done
echo "A=$SA ($A_WS)"; echo "B=$SB ($B_WS)"
[ "$A_WS" != "$B_WS" ] || fail "the two tasks share a workspace"
[ "$(git --git-dir="$REMOTE" rev-parse refs/heads/af/e2e-a)" = "$(acurl -sf "$BASE/api/tasks/$A_ID/detail" | jqr .publish.finalCommitSha)" ] || fail "task A was not published independently"
[ "$(git --git-dir="$REMOTE" rev-parse refs/heads/af/e2e-b)" = "$(acurl -sf "$BASE/api/tasks/$B_ID/detail" | jqr .publish.finalCommitSha)" ] || fail "task B was not published independently"

step "AC-29: cancel keeps the workspace and reports cancellation"
C=$(acurl -sf -X POST "$BASE/api/projects/$PROJ_ID/tasks" -H 'Content-Type: application/json' -d "{\"instruction\":\"Long task\",\"runtimeId\":\"$RT\",\"workingBranch\":\"af/e2e-c\"}")
C_ID=$(echo "$C" | jqr .task.id); C_WS=$(echo "$C" | jqr .workspace.path)
sleep 1.5
acurl -sf -X POST "$BASE/api/tasks/$C_ID/cancel" >/dev/null
CANCELLED=$(acurl -sf "$BASE/api/tasks/$C_ID/detail" | jqr .status)
echo "cancelled task status=$CANCELLED workspace=$C_WS"
[ "$CANCELLED" = "cancelled" ] || fail "the cancelled task did not report cancellation"
[ -d "$C_WS" ] || fail "the workspace was removed on cancel"
[ -z "$(acurl -s "$BASE/api/workspace-locks")" ] || [ "$(acurl -s "$BASE/api/workspace-locks" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")" = "0" ] || fail "a workspace lock was left behind"

step "CLI surface: af projects / af tasks detail"
CLI="node --import tsx packages/cli/src/index.ts --api $BASE"
$CLI projects list || fail "af projects list failed"
$CLI tasks detail "$TASK_ID" || fail "af tasks detail failed"
$CLI projects show "$PROJ_ID" || fail "af projects show failed"

step "ALL E2E CHECKS PASSED"
echo "work dir: $WORK"
