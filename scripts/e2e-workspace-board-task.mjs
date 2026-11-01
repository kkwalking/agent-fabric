#!/usr/bin/env node
/**
 * End-to-end walk of the three surfaces that carry the product, against a
 * **real** server and the **real** harness CLIs:
 *
 *   Workspace (a folder) -> Board (cards on it) -> Task execution (a card start
 *   is a Task with Runs), plus the interactions between all three.
 *
 * `verify-ui.mjs` drives the packaged window over CDP with a fixture database —
 * it proves the UI renders and reacts. This script proves the chain behind it
 * actually works: a folder becomes a workspace, a card on that board starts an
 * agent, the agent's turn lands on a Run and a Task, archiving keeps the
 * outcome, and deleting the workspace leaves nothing dangling. It talks to the
 * HTTP surface only, so it needs no window.
 *
 * Usage:
 *   npm run e2e                                        # local harness CLIs
 *   npm run e2e -- --agent dsh --keep                  # keep the scratch dir
 *
 * It starts its own server on a free port with a throwaway data directory and
 * a throwaway git repository, so it never touches `~/.fabric`, the user's own
 * boards, or this checkout. Exits non-zero on the first failed assertion.
 *
 * Requires: git on PATH, and at least one harness CLI (claude / pi / opencode /
 * dsh) that is installed and logged in — a card cannot run without one.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const wants = (flag) => args.includes(flag);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const keep = wants("--keep");
const onlyAgent = argValue("--agent", "");

/** A port that is free right now, so two runs never collide. */
function freePort() {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const root = mkdtempSync(join(tmpdir(), "af-e2e-"));
const dataDir = join(root, "data");
const projectDir = join(root, "project");
mkdirSync(dataDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
// A real repository: the board discovers `workspaceType: git` from it, and
// worktree-mode cards need one.
execFileSync("git", ["init", "-q"], { cwd: projectDir });
writeFileSync(join(projectDir, "README.md"), "# Demo project\n\nA tiny repo used to verify the board end to end.\n");
execFileSync("git", ["add", "-A"], { cwd: projectDir });
execFileSync(
  "git",
  ["-c", "user.email=e2e@example.test", "-c", "user.name=AgentFabric E2E", "commit", "-qm", "initial commit"],
  { cwd: projectDir }
);

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

// The server is started from the repository root, not from the caller's
// directory: `tsx` and the workspace symlinks are resolved from there.
const repoRoot = resolve(import.meta.dirname, "..");
const server = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "packages/server/src/index.ts")], {
  cwd: repoRoot,
  env: { ...process.env, AGENTFABRIC_DATA_DIR: dataDir, AGENTFABRIC_PORT: String(port), AGENTFABRIC_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (c) => (serverLog += String(c)));
server.stderr.on("data", (c) => (serverLog += String(c)));

/** Waits for the server's own health endpoint, then reads the token it wrote. */
async function waitForServer() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (server.exitCode !== null) throw new Error(`the server exited (${server.exitCode}):\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server never answered on ${BASE}:\n${serverLog}`);
}

function shutdown() {
  if (server.exitCode === null) server.kill("SIGTERM");
  if (!keep) rmSync(root, { recursive: true, force: true });
  else console.log(`[e2e] scratch directory kept at ${root}`);
}

await waitForServer();
const TOKEN = readFileSync(join(dataDir, "token"), "utf8").trim();
// The duplicate-directory check needs a second spelling of the same folder. On
// macOS /tmp is a symlink to /private/tmp, so its realpath is a different string
// for the same directory — exactly the case `resolve()` alone missed.
const projectAlt = (() => {
  try {
    return realpathSync(projectDir) === projectDir ? projectDir.replace(/\/$/, "") + "/" : realpathSync(projectDir);
  } catch {
    return projectDir;
  }
})();

const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`  ok   ${label}${detail ? ` (${detail})` : ""}`);
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` (${detail})` : ""}`); }
};
const step = (t) => console.log(`\n== ${t}`);
const j = async (method, path, body) => {
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
};
const get = (p) => j("GET", p);
const post = (p, b) => j("POST", p, b ?? {});
const patch = (p, b) => j("PATCH", p, b ?? {});
const del = (p) => j("DELETE", p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 60000, every = 700) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  return null;
};

// ---------------------------------------------------------------- workspace
step("1. Workspace: add a folder, and it is one record everywhere");
const added = await post("/api/kanban/workspaces", { rootPath: projectDir });
ok(added.status === 201, "POST /api/kanban/workspaces creates a board workspace", `status ${added.status}`);
const ws = added.data?.workspace;
ok(Boolean(ws?.board), "the record carries board settings", `type=${ws?.board?.workspaceType}`);
ok(ws?.path === projectDir, "the record's directory is the folder", ws?.path);
ok(ws?.ownership === "external", "the folder stays user-owned", ws?.ownership);

const plain = await get("/api/workspaces");
ok(plain.data?.some((w) => w.id === ws.id), "the same record is the plain workspace list", `${plain.data?.length} row(s)`);
const boardList = await get("/api/kanban/workspaces");
ok(boardList.data?.workspaces?.some((w) => w.id === ws.id), "…and the board's own list", `${boardList.data?.workspaces?.length} board(s)`);

const dupe = await post("/api/kanban/workspaces", { rootPath: projectDir });
ok(dupe.status === 409, "adding the same folder twice is refused", `status ${dupe.status} ${dupe.data?.code}`);
const dupeSlash = await post("/api/kanban/workspaces", { rootPath: `${projectDir}/` });
ok(dupeSlash.status === 409, "a trailing slash is the same folder", `status ${dupeSlash.status}`);
// Same directory, different string. `resolve()` alone answered "two folders"
// for these on macOS, so one project ended up with two records.
const symRes = await post("/api/kanban/workspaces", { rootPath: projectAlt });
ok(symRes.status === 409, "a symlinked spelling is the same folder", `${projectAlt} -> ${symRes.status} ${symRes.data?.code ?? ""}`);
ok(projectAlt !== projectDir, "the alternate spelling really is different text", `${projectDir} vs ${projectAlt}`);

step("2. Workspace mutation surface is a whitelist");
const hijack = await j("PUT", `/api/workspaces/${ws.id}`, { ownership: "managed", taskId: "task_anything" });
ok(hijack.status === 400, "a workspace cannot be made platform-owned over HTTP", `status ${hijack.status} ${hijack.data?.code}`);
const nullBoard = await j("PUT", `/api/workspaces/${ws.id}`, { board: null });
const afterNull = await get(`/api/workspaces/${ws.id}`);
ok(afterNull.data?.board != null, "board settings cannot be nulled away", `board=${JSON.stringify(afterNull.data?.board)}`);
const rename = await j("PUT", `/api/workspaces/${ws.id}`, { name: "e2e board" });
ok(rename.status === 200 && rename.data?.name === "e2e board", "a rename is still allowed", rename.data?.name);

// -------------------------------------------------------------------- board
step("3. Board: create a card on that workspace");
const agentList = await get("/api/kanban/agents");
const available = (agentList.data?.agents ?? []).filter((a) => a.available);
ok(available.length > 0, "at least one harness CLI is detected", available.map((a) => a.id).join(", "));
// Pick the agent this walk can actually drive unattended. A PTY/TUI harness
// opens its own full-screen interface — Claude presents the "trust this folder?"
// dialog in a directory no board created, and nothing answers it, so its turn
// never ends and every assertion about a settled outcome would be measuring the
// dialog rather than the product. An ACP agent (`dsh`) is a protocol server: the
// board speaks to it directly, a turn ends when the agent says it ended, and the
// harness's own session id comes back for a resume. Fall back to whatever is
// installed so the run still exercises the chain and reports what it saw.
const ACP_FIRST = ["dsh", "opencode"];
// `??` would keep the empty string `--agent` defaults to; this must fall
// through on "no preference asked for", not only on null/undefined.
const chosen =
  (onlyAgent ? available.find((a) => a.id === onlyAgent) : undefined) ??
  ACP_FIRST.map((id) => available.find((a) => a.id === id)).find(Boolean) ??
  available[0];
if (!chosen) {
  shutdown();
  throw new Error("no harness CLI is installed and usable — install or log into one of: claude, pi, opencode, dsh");
}
console.log(`  ..   using ${chosen.id} for the board card`);
const opencode = available.find((a) => a.id === "opencode");

if (opencode) {
  const models = await get("/api/kanban/agents/opencode/models");
  ok((models.data?.models ?? []).length > 5, "OpenCode's catalog is readable", `${models.data?.models?.length} models`);
}

const created = await post(`/api/kanban/workspaces/${ws.id}/cards`, {
  prompt: "Read README.md and write its first heading to NOTES.md. Do not change anything else.",
  agentId: chosen.id,
  permissionModeId: "workspace-write",
  executionMode: "direct",
});
ok(created.status === 201, "POST .../cards creates a card", `status ${created.status}`);
const card = created.data?.card;
ok(card?.column === "backlog", "a new card starts in Backlog", card?.column);
ok(Boolean(card?.title), "the card has a derived title", JSON.stringify(card?.title));

const cards = await get(`/api/kanban/workspaces/${ws.id}/cards`);
ok(cards.data?.cards?.length === 1, "the card is listed on its board", `${cards.data?.cards?.length}`);

step("4. Board: a cleared title is re-derived, never stored empty");
const cleared = await patch(`/api/kanban/cards/${card.id}`, { title: "   " });
ok(Boolean(cleared.data?.card?.title?.trim()), "clearing the title keeps a real one", JSON.stringify(cleared.data?.card?.title));

// -------------------------------------------------------- task execution
step("5. Task execution: starting a card produces a real Task + Run");
// Fire the same start twice at once, the way a double-click or a retried request
// does. One card is one Task: the second must resolve to the same session, never
// spawn a second agent.
const raced = await Promise.all([
  post(`/api/kanban/cards/${card.id}/start`),
  post(`/api/kanban/cards/${card.id}/start`),
]);
const racedIds = new Set(raced.map((r) => r.data?.session?.id).filter(Boolean));
ok(raced.every((r) => r.status === 200), "a duplicated start is a no-op, not an error", raced.map((r) => r.status).join("/"));
ok(racedIds.size === 1, "both starts name the same session", [...racedIds].join(", "));
const started = raced[0];
ok(started.data?.session?.id === started.data?.session?.runId, "the session handle IS its Run's id");
const taskId = started.data?.card?.taskId;
ok(Boolean(taskId), "the card now points at a Task", taskId);
ok(started.data?.card?.column === "in_progress", "the card moved to In Progress", started.data?.card?.column);

const task0 = await get(`/api/tasks/${taskId}`);
ok(task0.data?.workspaceId === ws.id, "the Task belongs to the workspace", task0.data?.workspaceId);
ok(task0.data?.execution?.phase === "agent.running", "the Task's execution phase is written at start", task0.data?.execution?.phase);
ok(task0.data?.execution?.agent?.attempts === 1, "first start is attempt 1", String(task0.data?.execution?.agent?.attempts));

const runs0 = await get(`/api/tasks/${taskId}/runs`);
ok(runs0.data?.length === 1, "exactly one Run so far, despite the duplicate start", `${runs0.data?.length}`);
ok(runs0.data?.[0]?.status === "running", "the Run is running", runs0.data?.[0]?.status);
const allTasks = await get("/api/tasks");
ok(allTasks.data?.length === 1, "and still exactly one Task", `${allTasks.data?.length}`);

step("6. Task execution: the turn actually runs and settles");
const settled = await until(async () => {
  const s = await get(`/api/kanban/cards/${card.id}/session`);
  const status = s.data?.session?.status;
  return status && !["starting", "running"].includes(status) ? s.data.session : null;
}, 240000);
ok(Boolean(settled), "the session reached a settled status", settled?.status);

const task1 = await get(`/api/tasks/${taskId}`);
const run1 = (await get(`/api/tasks/${taskId}/runs`)).data?.[0];
ok(run1?.status === "completed", "the Run completed", run1?.status);
ok(run1?.phase === "completed" || run1?.phase === "agent.running", "the Run's phase is not a stale value beside its status", `phase=${run1?.phase} status=${run1?.status}`);
ok(task1.data?.execution?.agent?.status === "completed", "the Task's agent stage says completed", task1.data?.execution?.agent?.status);
ok(task1.data?.execution?.failure === undefined, "there is no fabricated failure", JSON.stringify(task1.data?.execution?.failure));

const detail = await get(`/api/tasks/${taskId}/detail`);
ok(detail.data?.workspace?.id === ws.id, "the detail read model resolves the workspace", detail.data?.workspace?.name);
ok(detail.data?.runs?.length === 1, "the detail read model lists the Run", `${detail.data?.runs?.length}`);

step("7. Board <-> Task: the card and its Task agree, and Done keeps the outcome");
// Review -> Done is the user's move (`USER_MOVES.review = ["trash"]`); a drag
// back to Backlog is not a thing, and the board says so.
const badMove = await post(`/api/kanban/cards/${card.id}/move`, { column: "backlog" });
ok(badMove.status === 409, "Review only moves to Done, per the column rules", `status ${badMove.status} ${badMove.data?.code}`);
const archived = await post(`/api/kanban/cards/${card.id}/move`, { column: "trash" });
ok(archived.status === 200, "a finished card archives to Done", `column=${archived.data?.card?.column}`);
const sessionAfter = await get(`/api/kanban/cards/${card.id}/session`);
ok(["stopped", "awaiting_review"].includes(sessionAfter.data?.session?.status), "its process was released", sessionAfter.data?.session?.status);
const task2 = await get(`/api/tasks/${taskId}`);
const run2 = (await get(`/api/tasks/${taskId}/runs`)).data?.[0];
ok(run2?.status === "completed", "archiving did NOT rewrite the completed Run", `run=${run2?.status}`);
ok(task2.data?.execution?.agent?.status === "completed", "…nor the Task's completed agent stage", task2.data?.execution?.agent?.status);
ok(task2.data?.execution?.stages?.agent?.status === "completed", "the completed stage survives archiving", JSON.stringify(task2.data?.execution?.stages?.agent?.status));

step("8. Task execution: a completed card continues its own conversation, not a new Run");
// The archived card recorded the harness's session id, so starting it again
// resumes that conversation. The process belongs to the Run that already
// exists, so reopening the handle must NOT add a second Run: one conversation is
// one Run's worth of history.
await post(`/api/kanban/cards/${card.id}/move`, { column: "review" });
const resumed = await post(`/api/kanban/cards/${card.id}/start`, {});
ok(resumed.status === 200, "starting an archived card works", `status ${resumed.status}`);
ok(resumed.data?.session?.id === run1?.id, "it reopened the same Run (native resume)", `${resumed.data?.session?.id} vs ${run1?.id}`);
const runs3 = await get(`/api/tasks/${taskId}/runs`);
ok(runs3.data?.length === 1, "a resume adds no second Run", `${runs3.data?.length}`);
const task3 = await get(`/api/tasks/${taskId}`);
ok(task3.data?.execution?.agent?.attempts === 1, "…and does not inflate the attempt count", String(task3.data?.execution?.agent?.attempts));
const tasksAfter = await get("/api/tasks");
ok(tasksAfter.data?.length === 1, "still one Task, not two", `${tasksAfter.data?.length}`);


step("9. Task execution: cancelling through the task API refuses, and says where to stop");
const cancel = await post(`/api/tasks/${taskId}/cancel`);
ok(cancel.status === 409 && cancel.data?.code === "task-not-cancellable", "a live board card is not cancellable through the task API", `${cancel.status} ${cancel.data?.code}`);
const stillRunning = await get(`/api/kanban/cards/${card.id}/session`);
ok(["running", "starting", "awaiting_review"].includes(stillRunning.data?.session?.status), "and nothing was lied about", stillRunning.data?.session?.status);
const stopped = await post(`/api/kanban/cards/${card.id}/stop`);
ok(stopped.data?.session?.status === "stopped", "the real stop path works", stopped.data?.session?.status);

step("10. Workspace deletion is guarded while cards exist");
const blockedDelete = await del(`/api/workspaces/${ws.id}`);
ok(blockedDelete.status === 409, "deleting a board workspace with cards is refused", `${blockedDelete.status} ${blockedDelete.data?.code}`);
ok((await get(`/api/workspaces/${ws.id}`)).status === 200, "the workspace is still there");

step("11. Deleting every card, then the workspace, leaves no dangling reference");
for (const c of (await get(`/api/kanban/workspaces/${ws.id}/cards`)).data?.cards ?? []) {
  await del(`/api/kanban/cards/${c.id}`);
}
const emptied = await get(`/api/kanban/workspaces/${ws.id}/cards`);
ok(emptied.data?.cards?.length === 0, "the board is empty", `${emptied.data?.cards?.length}`);
const finalDelete = await del(`/api/workspaces/${ws.id}`);
ok(finalDelete.status === 200, "the workspace can now be deleted", `status ${finalDelete.status}`);
const tasksLeft = await get("/api/tasks");
ok((tasksLeft.data ?? []).every((t) => t.workspaceId !== ws.id), "no Task points at the deleted workspace", `dangling=${(tasksLeft.data ?? []).filter((t) => t.workspaceId === ws.id).length}`);
const deletedTasks = await get("/api/tasks?deleted=true");
ok((deletedTasks.data ?? []).length === 1, "the Task went to the recycle bin, not oblivion", `${deletedTasks.data?.length}`);

shutdown();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
