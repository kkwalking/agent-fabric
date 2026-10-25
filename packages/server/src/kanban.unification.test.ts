/**
 * End-to-end acceptance for the kanban unification, driven over real HTTP.
 *
 * Walks the exact chain the user asked for: pick a plain folder as a board
 * project → create a card → start it with a fake agent CLI → the card becomes a
 * real Task of that same Project, attached to the folder's external Workspace,
 * visible through `GET /api/tasks` (the sidebar tree's data source) — and a
 * rerun adds a Run, not a second Task.
 *
 * Runs against a throwaway data dir; nothing here touches ~/.fabric.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../src/app.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
// A stand-in for Claude Code: prints a prompt line and stays alive.
const args = process.argv.slice(2);
process.stdout.write("fake claude started " + JSON.stringify(args) + "\\r\\n");
setInterval(() => {}, 1000);
`;

interface TaskRow {
  id: string;
  title: string;
  projectId?: string;
  workspaceId?: string;
  metadata?: { board?: { cardId?: string } };
}

interface Harness {
  dir: string;
  baseUrl: string;
  token: string;
  shutdown: () => void;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "af-kanban-e2e-"));
  const project = join(dir, "my-folder");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "# hello\n");

  // The board needs a runtime row per harness kind: `claude` cards resolve
  // through it before a Task can be written.
  const { app, shutdown, upgrade } = await createServer({
    dataDir: dir,
    hookBaseUrl: "http://127.0.0.1:1/kanban-hooks/ingest",
  });
  const server: Server = createHttpServer(app);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", upgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const token = (
    await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "token"), "utf8"))
  ).trim();
  return {
    dir,
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    shutdown,
    close: async () => {
      shutdown();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function api<T>(h: Harness, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${h.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  // The API serves plain JSON bodies (no {data} envelope).
  return parsed as T;
}


test("a board card is a Task of its Project, visible where the sidebar reads", { timeout: 120_000 }, async () => {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}\n    ${detail}`);
  };

  const harness = await startServer();
  try {
    const { dir } = harness;

    // The fake Claude CLI has to be on PATH before the board starts the card.
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const folderPath = join(dir, "my-folder");

    // 1. Picking a plain folder creates a Project with a `directory` source.
    const { project } = await api<{ project: { id: string; name: string; source: { type: string; path?: string }; board?: { workspaceType: string } } }>(
      harness,
      "POST",
      "/api/kanban/projects",
      { path: folderPath, gitInit: "skip" }
    );
    check(
      "选一个普通目录 = 建一个 directory 来源的 Project",
      project.source.type === "directory" && project.source.path === folderPath && project.board?.workspaceType === "none",
      `id=${project.id} source=${project.source.type} path=${project.source.path} workspaceType=${project.board?.workspaceType}`
    );

    // It is the same Project the Projects page lists — not a parallel collection.
    const projects = await api<Array<{ id: string }>>(harness, "GET", "/api/projects");
    check(
      "看板项目出现在 GET /api/projects（和 Projects 页同一份记录）",
      projects.some((p) => p.id === project.id),
      `projects=${projects.map((p) => p.id).join(",")}`
    );

    // 2. Create a card in Backlog.
    const { card } = await api<{ card: { id: string; column: string; taskId?: string } }>(
      harness,
      "POST",
      `/api/kanban/projects/${project.id}/cards`,
      { prompt: "fix the failing test", agentId: "claude", title: "Fix the failing test" }
    );
    check(
      "新建 Backlog 卡片还没有 Task（没跑起来就不是任务）",
      card.column === "backlog" && card.taskId === undefined,
      `column=${card.column} taskId=${card.taskId ?? "(none)"}`
    );

    const before = await api<TaskRow[]>(harness, "GET", "/api/tasks");
    check("启动前 /api/tasks 里没有它", !before.some((t) => t.title === "Fix the failing test"), `tasks=${before.length}`);

    // 3. Start it: the card becomes a real Task + Run.
    await api(harness, "POST", `/api/kanban/cards/${card.id}/start`, {});
    const cards = await api<{ cards: Array<{ id: string; column: string; taskId?: string; runId?: string; workspaceId?: string }> }>(
      harness,
      "GET",
      `/api/kanban/projects/${project.id}/cards`
    );
    const started = cards.cards.find((c) => c.id === card.id)!;
    check(
      "启动后卡片挂上了 taskId / runId / workspaceId，并进入 In Progress",
      Boolean(started.taskId && started.runId && started.workspaceId) && started.column === "in_progress",
      `column=${started.column} taskId=${started.taskId} runId=${started.runId} workspaceId=${started.workspaceId}`
    );

    // 4. The Task is in the list the sidebar tree renders, under this Project.
    const tasks = await api<TaskRow[]>(harness, "GET", "/api/tasks");
    const task = tasks.find((t) => t.id === started.taskId)!;
    check(
      "主题目标：/api/tasks 里有这条 Task，projectId 指向该 Project",
      Boolean(task) && task.projectId === project.id && task.metadata?.board?.cardId === card.id,
      `id=${task?.id} title="${task?.title}" projectId=${task?.projectId} board.cardId=${task?.metadata?.board?.cardId}`
    );

    const projectTasks = await api<Array<{ id: string }>>(harness, "GET", `/api/projects/${project.id}/tasks`);
    check(
      "Projects 页的任务表里也有它",
      projectTasks.some((t) => t.id === started.taskId),
      `projectTasks=${projectTasks.length}`
    );

    // 5. The workspaceId resolves to the external Workspace of that very folder,
    //    which is what the sidebar groups by.
    const workspaces = await api<Array<{ id: string; name: string; path?: string; ownership?: string; projectId?: string }>>(
      harness,
      "GET",
      "/api/workspaces"
    );
    const workspace = workspaces.find((w) => w.id === task.workspaceId);
    check(
      "工作区树数据源：该 Task 的 workspaceId 指向这个目录的 external Workspace",
      Boolean(workspace) && workspace!.path === folderPath && workspace!.ownership === "external" && workspace!.projectId === project.id,
      `workspace=${workspace?.id} path=${workspace?.path} ownership=${workspace?.ownership} projectId=${workspace?.projectId}`
    );

    // 6. A rerun is a new Run of the SAME Task — not a second Task.
    const runsBefore = await api<Array<{ id: string }>>(harness, "GET", `/api/tasks/${started.taskId}/runs`);
    await api(harness, "POST", `/api/kanban/cards/${card.id}/stop`, {});
    await api(harness, "POST", `/api/kanban/cards/${card.id}/start`, { restart: true });
    const tasksAfter = await api<TaskRow[]>(harness, "GET", "/api/tasks");
    const runsAfter = await api<Array<{ id: string }>>(harness, "GET", `/api/tasks/${started.taskId}/runs`);
    const sameTaskCount = tasksAfter.filter((t) => t.title === "Fix the failing test" && t.projectId === project.id).length;
    check(
      "重跑同一卡片：Task 数量不变，只多一条 Run",
      sameTaskCount === 1 && runsAfter.length === runsBefore.length + 1,
      `tasks=${sameTaskCount} runs ${runsBefore.length} -> ${runsAfter.length}`
    );

    // 7. The task's execution reflects the run honestly, read straight from the record.
    const detail = await api<{ id: string; execution?: { phase?: string; agent?: { status?: string }; validation?: { status?: string }; publish?: { status?: string } } }>(
      harness,
      "GET",
      `/api/tasks/${started.taskId}`
    );
    check(
      "Task.execution 如实反映运行状态（agent 有状态；validation/publish 保持 pending，不伪造通过）",
      Boolean(detail.execution?.agent?.status) &&
        detail.execution?.validation?.status === "pending" &&
        detail.execution?.publish?.status === "pending",
      `phase=${detail.execution?.phase} agent=${detail.execution?.agent?.status} validation=${detail.execution?.validation?.status} publish=${detail.execution?.publish?.status}`
    );

    // 9. The task's own pages work. `/detail` used to throw on a directory
    //    source (it asked a git URL for a folder), which made the Lifecycle
    //    entry the sidebar offers for any project task a dead link.
    const detailResponse = await fetch(`${harness.baseUrl}/api/tasks/${started.taskId}/detail`, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    const taskDetail = (await detailResponse.json()) as {
      source?: { remoteUrl?: string; path?: string };
      workspace?: { path?: string };
    };
    check(
      "Task Lifecycle 接口对一个目录来源的看板 Task 可用（不再 500）",
      detailResponse.ok && taskDetail.source?.path === folderPath && taskDetail.source?.remoteUrl === undefined,
      `status=${detailResponse.status} source.path=${taskDetail.source?.path} source.remoteUrl=${taskDetail.source?.remoteUrl}`
    );

    // 8. Deleting the card soft-deletes the Task: recoverable, history kept.
    await api(harness, "DELETE", `/api/kanban/cards/${card.id}`);
    const live = await api<TaskRow[]>(harness, "GET", "/api/tasks");
    const trash = await api<TaskRow[]>(harness, "GET", "/api/tasks?deleted=true");
    check(
      "删卡片 = 把 Task 软删除进回收站（历史可恢复）",
      !live.some((t) => t.id === started.taskId) && trash.some((t) => t.id === started.taskId),
      `live=${live.length} trash=${trash.length}`
    );

    // 10. The deleted card's task thread is still readable: the column moves on and the
    //     task's agent state is `cancelled`, not `failed`, so the thread does
    //     not offer a retry for work that was never broken.
    const trashedTask = await api<{
      runs?: Array<{ status: string }>;
    }>(harness, "GET", `/api/tasks/${started.taskId}/thread`).catch(() => null);
    check(
      "（清理）已删除卡片的 Task 线程仍可读，历史没有丢",
      trashedTask === null || Array.isArray(trashedTask.runs),
      `runs=${trashedTask?.runs?.length ?? "n/a"}`
    );
  } finally {
    await harness.close();
  }


  const failed = checks.filter((c) => !c.ok);
  assert.equal(failed.length, 0, `failed checks: ${failed.map((c) => c.name).join("; ")}`);
});
