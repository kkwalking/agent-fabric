import test from "node:test";
import assert from "node:assert/strict";
import { buildKanbanLaunch, getKanbanAgent } from "./kanban/agents.js";
import type { KanbanAgentKind, KanbanCard, KanbanProject } from "@agentfabric/core";

const project: KanbanProject = {
  id: "kbproj_test",
  name: "test",
  rootPath: "/tmp/kanban-agents-test",
  workspaceType: "none",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function card(agentId: KanbanAgentKind, extra: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: "kbcard_test",
    projectId: project.id,
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

test("DSH launches its headless profile, not a bare binary", () => {
  const launch = buildKanbanLaunch(card("dsh"), project);
  assert.equal(launch.file, "dsh");
  // The CLI treats the first positional as the profile: `dsh <profile>`. A bare
  // `dsh -- <prompt>` exits with "--profile <name> is required" (the bug this
  // test pins down).
  assert.deepEqual(launch.args, ["--profile", "headless", "--", "fix the failing test"]);
  assert.equal(launch.interactiveTui, false);
  assert.equal(launch.env.AGENTFABRIC_KANBAN_CARD_ID, "kbcard_test");
});

test("DSH ignores the card's permission choice and model", () => {
  const launch = buildKanbanLaunch(
    card("dsh", { permissionModeId: "auto", model: "group/flash" }),
    project
  );
  assert.deepEqual(launch.args, ["--profile", "headless", "--", "fix the failing test"]);
});

test("Claude Code takes a positional prompt and its model flag", () => {
  assert.deepEqual(buildKanbanLaunch(card("claude"), project).args, ["fix the failing test"]);
  assert.deepEqual(buildKanbanLaunch(card("claude", { model: "opus" }), project).args, [
    "--model",
    "opus",
    "fix the failing test",
  ]);
});

test("OpenCode gets the prompt through --prompt", () => {
  assert.deepEqual(buildKanbanLaunch(card("opencode"), project).args, [
    "--prompt",
    "fix the failing test",
  ]);
});

test("a permission mode's args sit between the launch and the prompt", () => {
  assert.deepEqual(buildKanbanLaunch(card("claude", { permissionModeId: "plan" }), project).args, [
    "--permission-mode",
    "plan",
    "fix the failing test",
  ]);
  assert.equal(getKanbanAgent("claude").permissionModes.some((mode) => mode.id === "plan"), true);
});
