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

test("DSH takes its permission preset through the environment, not argv", () => {
  const dsh = getKanbanAgent("dsh");
  assert.equal(dsh.transport, "acp");
  // DSH's own three presets — a sandbox mode bundled with an approval policy.
  // ACP has no "switch the mode" surface, so each preset is a launch env value
  // the acp profile's base layer reads before the handshake.
  assert.deepEqual(
    dsh.permissionModes.map((mode) => mode.id),
    ["read-only", "workspace-write", "danger-full-access"]
  );
  assert.deepEqual(
    dsh.permissionModes.map((mode) => mode.env?.DSH_PERMISSION_MODE),
    ["read-only", "workspace-write", "danger-full-access"]
  );
  assert.deepEqual(
    dsh.permissionModes.map((mode) => mode.risky),
    [false, false, true]
  );
  // No "answer approvals for me" mode: approving is granting a sandbox
  // escalation, so the board always asks the card.
  assert.equal(dsh.permissionModes.some((mode) => mode.id === "auto"), false);
  assert.equal(dsh.defaultPermissionModeId, "workspace-write");

  const defaultLaunch = buildKanbanLaunch(card("dsh"), workspace);
  assert.deepEqual(defaultLaunch.args, ["--profile", "acp"]);
  assert.equal(defaultLaunch.env.DSH_PERMISSION_MODE, "workspace-write");

  const readOnly = buildKanbanLaunch(card("dsh", { permissionModeId: "read-only" }), workspace);
  assert.deepEqual(readOnly.args, ["--profile", "acp"]);
  assert.equal(readOnly.env.DSH_PERMISSION_MODE, "read-only");

  // The card model is not wired to ACP config options yet, and the preset is
  // env — the argv stays exactly the ACP launch.
  const full = buildKanbanLaunch(
    card("dsh", { permissionModeId: "danger-full-access", model: "group/flash" }),
    workspace
  );
  assert.deepEqual(full.args, ["--profile", "acp"]);
  assert.equal(full.env.DSH_PERMISSION_MODE, "danger-full-access");
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
