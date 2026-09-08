/**
 * Unit tests for the claude stream-json mapper (v7 §4/§7/§8/§14) — the
 * protocol shapes verified against claude-cli 2.1.x.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractClaudeSessionRef,
  mapClaudeEvent,
  newClaudeEventMapperState,
  parseClaudeUsage,
  detectClaudeUsageLimit,
} from "./claudecode.js";

let seqCounter = 0;
const seq = () => ++seqCounter;
const map = (line: string, state = newClaudeEventMapperState()) => mapClaudeEvent(line, "run_x", seq, state);
const first = (line: string, state = newClaudeEventMapperState()) => {
  const out = map(line, state);
  return Array.isArray(out) ? out[0] : out;
};

test("system/init yields the native session reference (v7 §5)", () => {
  const raw = '{"type":"system","subtype":"init","session_id":"dba0e5a5-193a-4f74-ab06-dd79ff69d0e2","model":"claude-sonnet-5"}';
  assert.equal(extractClaudeSessionRef(raw), "dba0e5a5-193a-4f74-ab06-dd79ff69d0e2");
  const evt = map(raw);
  assert.equal(evt && !Array.isArray(evt) ? evt.type : undefined, "run.progress");
  // Hook plumbing is skipped entirely.
  assert.equal(map('{"type":"system","subtype":"hook_started","hook_id":"h1"}'), null);
  assert.equal(map('{"type":"system","subtype":"hook_response","hook_id":"h1","stdout":"noise"}'), null);
  assert.equal(extractClaudeSessionRef("not json"), undefined);
});

test("assistant text and thinking blocks map to message/thinking events (v7 §7)", () => {
  const evts = map(
    '{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"thinking","thinking":"plan first"},{"type":"text","text":"ok"}]}}'
  );
  assert.ok(Array.isArray(evts));
  assert.equal(evts.length, 2);
  assert.equal(evts[0].type, "agent.thinking");
  assert.equal(evts[0].data.content, "plan first");
  assert.equal(evts[1].type, "agent.message");
  assert.equal(evts[1].data.content, "ok");
  assert.equal(evts[1].data.model, "claude-sonnet-5");
  assert.equal(map('{"type":"assistant","message":{"role":"assistant","content":[]}}'), null);
});

test("Bash tool_use maps to shell.command, its result to shell.output (v7 §7)", () => {
  const state = newClaudeEventMapperState();
  const started = first(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm test"}}]}}',
    state
  );
  assert.equal(started?.type, "shell.command");
  assert.equal(started?.data.command, "npm test");

  const done = map(
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"3 passing","is_error":false}]}}',
    state
  );
  const out = Array.isArray(done) ? done[0] : done;
  assert.equal(out?.type, "shell.output");
  assert.equal(out?.data.output, "3 passing");
});

test("Edit/Write tool_use maps to file activity plus tool lifecycle (v7 §7)", () => {
  const state = newClaudeEventMapperState();
  const write = map(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_w","name":"Write","input":{"file_path":"src/new.ts"}}]}}',
    state
  );
  const writeStart = Array.isArray(write) ? write[0] : write;
  assert.equal(writeStart?.type, "tool.started");

  const writeDone = map(
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_w","content":"written","is_error":false}]}}',
    state
  );
  assert.ok(Array.isArray(writeDone));
  assert.equal(writeDone[0].type, "file.created");
  assert.equal(writeDone[0].data.path, "src/new.ts");
  assert.equal(writeDone[1].type, "tool.completed");

  const editStarted = map(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_e","name":"Edit","input":{"file_path":"src/a.ts"}}]}}',
    state
  );
  assert.equal(Array.isArray(editStarted) ? editStarted[0].type : undefined, "tool.started");
  const editDone = map(
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_e","content":"updated","is_error":false}]}}',
    state
  );
  assert.ok(Array.isArray(editDone));
  assert.equal(editDone[0].type, "file.modified");
  assert.equal(editDone[0].data.path, "src/a.ts");
  assert.equal(editDone[1].type, "tool.completed");
  // An unrecorded tool_use id (result only) still completes generically.
  const orphan = map(
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"?","is_error":false}]}}',
    state
  );
  const orphanOut = Array.isArray(orphan) ? orphan[0] : orphan;
  assert.equal(orphanOut?.type, "tool.completed");
  assert.equal(orphanOut?.data.tool, "tool");
});

test("generic tools map to tool.started/tool.completed pairs (v7 §7)", () => {
  const state = newClaudeEventMapperState();
  const started = first(
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_r","name":"Read","input":{"file_path":"README.md"}}]}}',
    state
  );
  assert.equal(started?.type, "tool.started");
  assert.equal(started?.data.tool, "Read");
  assert.equal(started?.data.toolCallId, "toolu_r");

  const done = map(
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_r","content":[{"type":"text","text":"# hi"}],"is_error":false}]}}',
    state
  );
  const out = Array.isArray(done) ? done[0] : done;
  assert.equal(out?.type, "tool.completed");
  assert.equal(out?.data.result, "# hi");
});

test("result usage is authoritative; cost is harness-reported only (v7 §8)", () => {
  const usage = parseClaudeUsage(
    '{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":3356,"total_cost_usd":0.080465,"usage":{"input_tokens":15738,"output_tokens":71,"cache_read_input_tokens":0,"cache_creation_input_tokens":12,"output_tokens_details":{"thinking_tokens":5}}}'
  );
  assert.deepEqual(
    usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      modelRequests: usage.modelRequests,
      durationMs: usage.durationMs,
      estimatedCost: usage.estimatedCost,
    },
    { inputTokens: 15738, outputTokens: 71, cachedTokens: 12, reasoningTokens: 5, modelRequests: 1, durationMs: 3356, estimatedCost: 0.080465 }
  );
  // No total_cost_usd → no fabricated cost (subscription runs are never
  // estimated against Anthropic API pricing).
  const unmetered = parseClaudeUsage('{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":2}}');
  assert.equal(unmetered?.estimatedCost, undefined);
  assert.equal(parseClaudeUsage('{"type":"assistant","message":{}}'), undefined);
  assert.equal(parseClaudeUsage("not json"), undefined);
});

test("error results keep their identity and classify quota exhaustion (v7 §14)", () => {
  const failed = map(
    '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude usage limit reached. You\'ve hit your usage limit and it resets at 5pm."}'
  );
  assert.equal(failed && !Array.isArray(failed) ? failed.type : undefined, "runtime.error");
  assert.equal(failed && !Array.isArray(failed) ? failed.data.usageLimit : undefined, true);

  const maxTurns = map('{"type":"result","subtype":"error_max_turns","is_error":true,"result":"stopped"}');
  assert.equal(maxTurns && !Array.isArray(maxTurns) ? maxTurns.type : undefined, "runtime.error");
  assert.equal(maxTurns && !Array.isArray(maxTurns) ? maxTurns.data.usageLimit : undefined, false);

  assert.equal(detectClaudeUsageLimit("You've hit your usage limit. It resets at 11pm."), true);
  assert.equal(detectClaudeUsageLimit("usage_limit_reached"), true);
  assert.equal(detectClaudeUsageLimit("ENOENT: no such file"), false);
});

test("unknown lines stay visible as raw debug events (v7 §7)", () => {
  const evt = map('{"type":"something.new","payload":1}');
  assert.equal(evt && !Array.isArray(evt) ? evt.type : undefined, "log");
  assert.equal(map("plain text line"), null);
});
