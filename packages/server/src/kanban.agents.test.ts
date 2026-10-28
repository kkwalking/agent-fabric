import test from "node:test";
import assert from "node:assert/strict";
import { buildKanbanLaunch, getKanbanAgent } from "./kanban/agents.js";
import type { KanbanAgentKind, KanbanCard, Workspace } from "@agentfabric/core";

// A board workspace is a Workspace: the folder is its `path` and the
// board-only choices live in `board`.
const workspace: Workspace = {
  id: "ws_test",
  name: "test",
  type: "local",
  path: "/tmp/kanban-agents-test",
  persistent: true,
  board: { workspaceType: "none" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function card(agentId: KanbanAgentKind, extra: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "kbcard_test",
    workspaceId: workspace.id,
    title: "test",
    prompt: "fix the failing test",
    column: "backlog",
    agentId,
    executionMode: "direct",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

test("DSH launches the ACP app and carries the prompt over the protocol", () => {
  const launch = buildKanbanLaunch(card("dsh"), workspace);
  assert.equal(launch.file, "dsh");
  // DSH has no TUI; the board drives its ACP stdio app. The prompt is a
  // protocol request after the handshake, never an argv element.
  assert.deepEqual(launch.args, ["--profile", "acp"]);
  assert.equal(launch.transport, "acp");
  assert.equal(launch.interactiveTui, false);
  assert.equal(launch.env.AGENTFABRIC_KANBAN_CARD_ID, "kbcard_test");
});

test("DSH ignores the card's model; its permission choice is runtime policy, not argv", () => {
  const launch = buildKanbanLaunch(
    card("dsh", { permissionModeId: "auto", model: "group/flash" }),
    workspace
  );
  assert.deepEqual(launch.args, ["--profile", "acp"]);
  const dsh = getKanbanAgent("dsh");
  assert.equal(dsh.transport, "acp");
  assert.deepEqual(
    dsh.permissionModes.map((mode) => mode.id),
    ["default", "auto"]
  );
});

test("Claude Code takes a positional prompt and its model flag", () => {
  assert.deepEqual(buildKanbanLaunch(card("claude"), workspace).args, ["fix the failing test"]);
  assert.deepEqual(buildKanbanLaunch(card("claude", { model: "opus" }), workspace).args, [
    "--model",
    "opus",
    "fix the failing test",
  ]);
});

test("OpenCode gets the prompt through --prompt", () => {
  assert.deepEqual(buildKanbanLaunch(card("opencode"), workspace).args, [
    "--prompt",
    "fix the failing test",
  ]);
});

test("a permission mode's args sit between the launch and the prompt", () => {
  assert.deepEqual(buildKanbanLaunch(card("claude", { permissionModeId: "plan" }), workspace).args, [
    "--permission-mode",
    "plan",
    "fix the failing test",
  ]);
  assert.equal(getKanbanAgent("claude").permissionModes.some((mode) => mode.id === "plan"), true);
});
