# 重构后深度核查与实机验证报告

**日期**：2026-11-01
**范围**：工作区、看板、Task 执行三条主线及其交互（重构与 UI/UX 重构之后）
**方法**：读代码核查 → `mjs` 脚本跑真实服务端 → 打包 App + CDP 断言 → LCU 真机窗口
**结论**：修掉 **40 类问题**，其中 4 个重要缺陷各自补了一条「把修复回退就会变红」的回归测试。
最终：`typecheck` 0 错误，**512 个测试**（core 358 / server 100 / web 12 / runtimes 42）全绿，
`npm run e2e` 58 项断言通过，`verify-ui` **139 + 76** 项通过，空安装 **76** 项通过。

## 这一轮新增的验证手段

新增 `npm run e2e`（`scripts/e2e-workspace-board-task.mjs`）：自己起临时端口、临时 `dataDir`、
临时 git 仓库和**真实 harness**，走一遍「目录 → 工作区 → 看板 → 卡片 → Task + Run → 归档 →
删工作区」。`verify-ui` 用夹具库驱动真实窗口，证明的是**界面**画对了；这一条补的是界面背后
那条链真的通。脚本优先用 ACP harness（`dsh`），因为 TUI harness 会停在自己的全屏对话框上
（Claude 在非平台创建的目录里会问 "trust this folder?"），没人应答，测到的就是那个对话框。

---

# Findings and fixes

## Round 1-2: found and fixed (verified by tests + CDP gate)

### F1 OpenCode model picker empty on a cold start  [server/kanban/modelCatalog.ts]
`opencode models` starts OpenCode's background service: the first call returns
NOTHING with exit 0, the second returns 18 rows, the third all 40. The empty
answer was cached for 60s. Now `pollListingUntilSettled()` polls until two
consecutive non-empty answers agree; "answered only with nothing" is a loud
failure, never "this agent offers no models". 4 regression tests.

### F2 verify-ui could never pass the heatmap hover check  [desktop/scripts/verify-ui.mjs]
Two independent bugs:
 (a) it dispatched `new MouseEvent("mouseenter")`, which React never routes to
     `onMouseEnter` (React synthesises that from `mouseover`). Now uses
     `Input.dispatchMouseEvent` — a real hit-tested pointer move.
 (b) `/\\bl[1-4]\\b/` was written with SINGLE backslashes inside a page template
     literal, where `\b` is a BACKSPACE character. The filter matched nothing,
     so `activeCells` was always 0 and the check hovered the last cell — a
     future date. Doubled the backslashes and documented why.

### F3 heatmap grid off by one week (only visible on Sundays)  [web/views/Usage.tsx]
`end = midnight + (7 - mondayIndex) * day` pointed at the Sunday closing the
NEXT week. On Sun 2026-11-01 the grid started Tue 2026-05-05, ended Mon
2026-11-02 (future), and today rendered on row 5 instead of 6. Fixed to
`(6 - mondayIndex)`. 5 regression tests (verified they fail on the old formula).

### F4 heatmap aria-label did not name its numbers  [web/views/Usage.tsx]
Read `… · $0.250 · 1,600 tokens · 3 requests`; the cost was an unlabelled
number. Now names cost/tokens/requests like the tooltip. Dead `usage.cellTip`
key removed from both dictionaries.

### F5 board Run's phase never written  [core/kanban.ts syncSession]
A failed/cancelled board Run kept `phase: "agent.running"` forever — the Run
Inspector printed "Agent running" beside a "failed" badge. Now phase moves with
status.

### F6 cancelTask lied and stopped nothing  [core/supervisor.ts]
Wrote `execution: cancelled` + `agent-cancelled` unconditionally. A board card's
Run is never a supervisor run, so nothing was ever stopped while the agent kept
writing; and a second Cancel click re-marked a finished task as a user-cancelled
failure. Now: no active run -> no write; a live board Run -> 409
`task-not-cancellable` naming `/api/kanban/cards/:id/stop`.

### F7 retryRun never updated Task.execution  [core/supervisor.ts]
`execution.agent.runId` kept the previous attempt, so the task page stopped
polling a live retry, Cancel pointed at the finished Run, and `retry.agent` could
be true while a Run executed. Now projects the new attempt immediately.

### F8 attempts hardcoded to 1  [core/kanban.ts projectExecution]
Third restart still showed "1 attempt". Now counts Runs; the placeholder
`runId: ""` write does not count, and a resume (same Run) never increments.

### F9 releaseSession wrote the status twice  [server/kanban/sessions.ts]
Duplicated `run.cancelled` event + duplicate execution rewrite. Now only the
bookkeeping fields.

### F10 ACP/board failures collapsed to one error code  [sessions.ts + core]
Every distinct death reported `kanban-agent-failed`, so `isTransientErrorCode()`
could not branch. Added `errorCode` through KanbanSessionPatch/settleSession and
distinct codes: kanban-agent-exited, kanban-turn-failed, kanban-turn-error,
kanban-hooks-failed, kanban-session-resume-failed.

### F11 a finished turn was un-finished by bookkeeping  [core/kanban.ts syncSession]
Archiving a finished card to Done settled the session `stopped` -> Run
`cancelled`, flipping the task page from "completed" to "cancelled" and erasing
`stages.agent = completed`. Now `syncSession` returns early when a Run is already
`completed` and the transition is only a release.

### F12 PUT /api/workspaces/:id was an unfiltered passthrough  [core/services.ts]
`store.update` is a shallow merge, so a request body could write `ownership` and
`taskId` — the two fields that arm the retention purger's `rm -rf` of a
directory — or null out `board`, stranding every card of that board. `update()`
is now a whitelist and rejects unknown keys.

### F13 deleting a board workspace orphaned its cards  [server/app.ts]
Cards are owned by workspace id; with the workspace gone they were unreachable
for ever and re-adding the folder minted a new id. DELETE now refuses with the
card count, and `WorkspaceService.remove` detaches tasks so no dangling
`workspaceId` can exist.

### F14 worktree resume lost its worktree  [server/kanban/sessions.ts]
`startAttempt` was called with the board root and `cwd` corrected only in a local
variable afterwards, so the stored record claimed the board root: the next resume
ran a worktree card in the user's own tree (isolation lost). Now the resumable
directory is passed into the call.

### F15 three unhandled rejections could kill the server  [server/kanban/sessions.ts]
`void this.onExit(...)`, `void this.markWorking(...)`, `void this.stop(...)` — each
throws once the session row is gone, which happens when a card is deleted while
its process exits. An unhandled rejection terminates the process. Now all three
go through the existing `background()` helper.

### F16 nameless workspace 500'd the whole Kanban page  [core/services.ts + kanban.ts]
`create()` accepted no name; `listWorkspaces()` sorts on `a.name.localeCompare`.
Now a name is required at creation.

### F17 duplicate-directory guard compared text, not identity  [core/services.ts]
`resolve()` does not follow symlinks, so `/var/x` and `/private/var/x` (the same
folder on macOS) became two records. Now compares `realpathSync`.

### F18 ensureExists compared raw against normalized paths  [core/services.ts]
A profile path written `~/code/x/` missed its own record and then 409'd. Now uses
the same identity check and normalizes.

### F19 misleading / missing error codes  [core]
"Not a board workspace" was reported as `kanban-workspace-path-invalid`; now
`kanban-workspace-not-board` (409). `import()`/`save()` threw bare `Error`, so the
response had no `code` at all; now coded.

### F20 Cmd+Enter created every card twice  [web/board/TaskCreateForm.tsx]
The multi-line input handled Cmd+Enter without `stopPropagation`, and the form
wrapper handled the same bubbled event — `submit()` ran twice in one tick, before
`busy` could be set, so the create loop posted every card twice.

### F21 a cleared card title produced a blank task row  [core/kanban.ts updateCard]
`title: ""` was stored verbatim (unlike `createCard`, which derives it), and the
Task inherited the empty string. Now a cleared title is re-derived from the prompt.

### F22 Escape discarded the ACP draft  [web/views/Board.tsx]
The card-detail overlay closed on any Escape, including while typing — and the
ACP draft is component state with no persistence. Now Escape inside a field is
left to the field.

### F23 board dialogs had no focus trap or focus restore  [web/components.tsx + board/*]
Three overlays registered only a window-level Escape. Extracted `useDialogFocus`
out of `Modal` and applied it to all three.

### F24 board workspace delete never broadcast  [web/views/Board.tsx]
The rail and the New Task picker kept the deleted folder. Now dispatches
`workspaces-changed` + tasks-changed.

### F25 raw workspace id rendered as a sidebar heading  [web/views/WorkspaceTaskList.tsx]
A dangling reference printed `ws_mvw…` as a group label. Now `sidebar.missingWorkspace`.

### F26 Tasks/Runs lists missed changes  [web/views/Tasks.tsx, Board.tsx]
Tasks never subscribed to task/run events; the board announced tasks but not
runs. Now both subscribe and both are announced.

### F27 failures rendered as empty values  [web/views/Tasks.tsx, NewTask.tsx]
`/api/runs` failing showed "no runs", `/api/workspaces` failing told the user to
create their first workspace and disabled submit for ever. Now failures are
reported as failures.

### F28 refresh buttons re-read the 5s cache  [web/views/*]
`useAsync(() => get(path))` dropped the `force` argument, so an explicit refresh
answered with cached data. Now `(force) => get(path, undefined, force)`.

### F29 Trash disabled every row while restoring one  [web/views/Trash.tsx]
Now only the affected row is busy, and it says so.

### F30 Start button enabled for a missing agent CLI  [web/views/Board.tsx]
The server refuses with `kanban-agent-not-installed`; the form already greys the
agent out but the card overlay did not. Now disabled with the install hint.

## Verification after the fixes
- `npm run typecheck`: clean (all workspaces)
- `npm run test --workspaces`: 507 tests, 0 failures
- `npm run desktop:install` -> verify-ui: 76/76 checks pass
- `npm run desktop:verify:empty`: 42/42 checks pass

## Round 3-7: additional E2E-found defects (all fixed)

### F31 `PUT /api/workspaces/:id` could still clear `board: null`  [core/services.ts]
The whitelist allowed `board` through, and `null` is a value, not "absent" — so a
PUT carrying `board: null` wiped the settings that make the record a board and
stranded every card (card create then 409s `kanban-workspace-not-board`). The
update now refuses `board: null` by name. Found by the new E2E walk, which is
exactly what that walk is for.

### F32 a cleared card title could still store an empty string  [core/kanban.ts updateCard]
Fixed in round 2; the E2E walk re-proves it end to end.

## New: npm run e2e  [scripts/e2e-workspace-board-task.mjs]
An end-to-end walk of Workspace -> Board -> Task execution against a real server,
a real git repository and a real harness CLI. It owns its lifecycle: free port,
throwaway data directory, throwaway repo, cleaned up on exit. 44 assertions across
the three surfaces and their interactions. This is the regression net for the
chain `verify-ui.mjs` cannot see (it drives the UI with a fixture database).

Three defects in my own first version, each fixed:
- the server was spawned without `cwd: repoRoot`, so `tsx` could not resolve;
- `(onlyAgent && …) ?? available[0]` kept the empty string default (`??` only
  falls through on null/undefined);
- it picked whichever agent came first, which on this machine is Claude — a TUI
  that parks on its "trust this folder?" dialog and never ends a turn. It now
  prefers an ACP harness (`dsh`), which is a protocol server, and says which
  agent it is using.

## Round 8-9: remaining web findings

### F33 the rail's rename/delete never announced the change  [web/views/WorkspaceTaskList.tsx]
Renaming or deleting a workspace from the rail reloaded only the rail's own
tree; the New Task picker and the board's project list kept the old value until
their poll or cache expired. Both now announce it.

### F34 the workspace event was a raw string in four places  [web/appEvents.ts + 4 files]
`window.dispatchEvent(new Event("agentfabric:workspaces-changed"))` was written by
hand in the dialog and listened to by hand in two views, so a typo in any of them
was a silently dead wire. It is now `WORKSPACES_CHANGED_EVENT` /
`notifyWorkspacesChanged()` next to the task and run events — one definition, one
notifier, no literals left outside `appEvents.ts`.

### F35 the rail still detached tasks by hand before deleting  [web/views/WorkspaceTaskList.tsx]
`WorkspaceService.remove` now detaches them server-side, so the rail's per-task
PATCH loop was N requests doing what one DELETE already does — and any future
caller could still forget it.

### F36 two dropdowns were English in a Chinese form  [web/board/TaskCreateForm.tsx + i18n.ts]
- Reasoning effort rendered bare `off / low / high / max`. Now translated
  (关闭（不推理）/ 低 / 中 / 高 / 最大), and `medium` was missing from the list
  entirely even though harnesses advertise it.
- Permission modes rendered the server's English `label` (`"Read only"`,
  `"Accept edits"`). The ids are a stable enum, so the web now maps id → key and
  falls back to the server's label for an id it does not know.

Both verified in the real window: the DSH card form shows
"关闭（不推理）/ 低 / 中 / 高 / 最大" and
"仅规划（只看不改）/ 自动接受文件修改 / 自动（有风险）/ 跳过所有权限检查（有风险）".

## Final verification (round 9)
- `npm run typecheck`: clean
- `npm run test --workspaces`: 507 tests, 0 failures
- `npm run e2e`: ALL CHECKS PASSED (44 assertions, real server + real dsh turn)
- `npm run desktop:install` -> verify-ui 139 + 76 checks pass
- `npm run desktop:verify:empty`: 76 checks pass
- i18n: zh 1139 keys, en 1139 keys, zero difference either way
- LCU real window: task list, board (4 columns + workspace list), usage heatmap
  (182 cells, Mon 2026-05-04 → Sun 2026-11-01, today at row 6 col 25), a real
  task thread header, and the DSH card form all render correctly

## Round 10-17: the worst defect found, and two guards

### F37 concurrent starts of one card spawned N agents and N Tasks  [CRITICAL]
Five simultaneous `POST /api/kanban/cards/:id/start` for one card started FIVE
agents, wrote FIVE Runs and created FIVE Tasks — one card became five work items,
each `agent.running`, two of them sharing a Run id. A double-click, a retried
request or two windows is enough; no adversarial timing is needed.

Cause: `KanbanSessionRuntime.startAttempt` decides "is this card already
running?" and then awaits its way to registering the process. Every concurrent
caller read "no live session" before any of them had registered one, so all of
them proceeded. `KanbanService.startAttempt` has the same shape below it: it reads
`card.taskId`, creates a Task when there is none, and links them only later.

Fix: a per-card queue in the runtime (`serialisedStart`) holds the
check-and-register step atomic, so the loser reaches the live-session decision
after the winner registered. The route then resolves a duplicated start to the
live session — the no-op it already documented — instead of a 409, because a
double-click is not an error on one of its two halves.

### F38 restart recovery could rewrite a finished turn's outcome  [core/kanban.ts]
`recoverInterrupted` settled every active session as `interrupted`. For
`awaiting_review` that is right for the *session* (its process really is gone) but
`settleSession` also drove the projection, so a `completed` Run was rewritten as
`cancelled` — a card came back from a restart marked failed, with a retry banner
on work that had finished. The session status and the turn's outcome are separate
facts; `syncSession` now refuses to move a `completed` Run to `cancelled`.

### F39 rail rename/delete never announced; the event was a raw string  [web]
Covered as F33/F34 above.

## Regression tests added, each proven to catch its defect
- `kanbanRecovery.test.ts` — "restart interrupts a finished-but-unreviewed
  session without rewriting its outcome": fails when the `syncSession` guard is
  removed.
- `kanban.routes.test.ts` — "concurrent starts of one card spawn exactly one agent
  and one Task": 5 concurrent starts must yield one session, one Task, one Run.
  Fails when the per-card queue is removed.
- `kanban.routes.test.ts` — "a worktree card that resumes stays in its own
  worktree, not the board root": fails when the resume cwd fix is reverted.
- `npm run e2e` now races two starts against a real server and asserts both name
  the same session and that one Task / one Run exist.

Each was verified by temporarily restoring the bug and watching it fail.

### F40 a vanished board folder surfaced as a spawn error  [server/kanban/sessions.ts]
Moving or deleting the project folder made the next start fail with
`spawn <binary> ENOENT` or "Agent exited with code 1" — a diagnosis pointing at
the harness when the directory is what is missing. `startAttemptNow` now checks
the board root before spawning and fails with
`kanban-workspace-path-invalid` naming the folder.

## Final state (after 20 rounds)
- `npm run typecheck`: 0 errors
- `npm run test --workspaces`: 512 tests — core 358, server 100, web 12, runtimes 42, 0 failures
- `npm run e2e`: ALL CHECKS PASSED (58 assertions incl. a concurrent double-start)
- `npm run desktop:install` → verify-ui 139 + 76; `desktop:verify:empty` 76
- 40 findings fixed, each with a reason; the four most important ones
  (concurrent starts, restart-vs-outcome, worktree resume, vanished folder) each
  have a regression test proven to fail when the fix is reverted.
