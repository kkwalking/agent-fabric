import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareKanbanHooks } from "./kanban/hooks.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "af-kanban-hooks-"));
}

test("Claude hook settings carry the four transition hooks", async () => {
  const dir = tempDir();
  try {
    const setup = await prepareKanbanHooks({
      agentId: "claude",
      dataDir: dir,
      sessionId: "sess_claude",
      baseUrl: "http://127.0.0.1:1/kanban-hooks/ingest",
      token: "test-token",
    });
    const settings = JSON.parse(readFileSync(join(setup.dir, "claude-settings.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    assert.ok(settings.hooks.Stop);
    assert.ok(settings.hooks.UserPromptSubmit);
    assert.ok(settings.hooks.Notification);
    const stop = JSON.stringify(settings.hooks.Stop);
    assert.match(stop, /to_review/);
    assert.match(stop, /x-kanban-hook-token: test-token/);
    // A pending dialog must read as "waiting on a human", not as a finished
    // turn. PermissionRequest is the only hook that sees AskUserQuestion
    // (verified on Claude Code 2.1.302: no Notification, no Stop until the
    // answer); Notification with a permission_prompt matcher covers tool
    // approvals.
    const permission = JSON.stringify(settings.hooks.PermissionRequest);
    assert.match(permission, /needs_attention/);
    const notification = JSON.stringify(settings.hooks.Notification);
    assert.match(notification, /needs_attention/);
    assert.match(notification, /permission_prompt/);
    assert.deepEqual(setup.extraArgs.slice(0, 1), ["--settings"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode plugin/config are generated and the plugin parses", async () => {
  const dir = tempDir();
  try {
    const setup = await prepareKanbanHooks({
      agentId: "opencode",
      dataDir: dir,
      sessionId: "sess_open",
      baseUrl: "http://127.0.0.1:1/kanban-hooks/ingest",
      token: "test-token",
    });
    const config = JSON.parse(readFileSync(join(setup.dir, "opencode.json"), "utf8")) as {
      plugin: string[];
    };
    assert.ok(Array.isArray(config.plugin));
    assert.match(config.plugin[0]!, /^file:\/\//);
    assert.equal(setup.extraEnv.OPENCODE_CONFIG, join(setup.dir, "opencode.json"));
    // The generated plugin is real ESM; a syntax error here would only surface
    // when a user opens OpenCode, so parse it now.
    execFileSync(process.execPath, ["--check", join(setup.dir, "kanban-plugin.mjs")], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi and DSH have no hook files, only the callback env", async () => {
  for (const agentId of ["pi", "dsh"] as const) {
    const dir = tempDir();
    try {
      const setup = await prepareKanbanHooks({
        agentId,
        dataDir: dir,
        sessionId: `sess_${agentId}`,
        baseUrl: "http://127.0.0.1:1/kanban-hooks/ingest",
        token: "test-token",
      });
      assert.equal(setup.extraArgs.length, 0);
      assert.equal(setup.extraEnv.AGENTFABRIC_KANBAN_HOOK_TOKEN, "test-token");
      assert.equal(setup.extraEnv.AGENTFABRIC_KANBAN_SESSION_ID, `sess_${agentId}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
