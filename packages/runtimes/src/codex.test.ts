/**
 * Unit tests for the codex exec JSONL mapper (v6 §5/§10) — the protocol
 * shapes verified against codex-cli 0.153.x.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexSessionRef,
  mapCodexEvent,
  parseCodexUsage,
  detectCodexUsageLimit,
} from "./codex.js";

let seqCounter = 0;
const seq = () => ++seqCounter;
const map = (line: string) => mapCodexEvent(line, "run_x", seq);

test("thread.started yields the native session reference (v6 §4)", () => {
  const raw = '{"type":"thread.started","thread_id":"01a07ae7-6479-74c1-bcca-9c1ee911acde"}';
  assert.equal(extractCodexSessionRef(raw), "01a07ae7-6479-74c1-bcca-9c1ee911acde");
  const evt = map(raw);
  assert.equal(evt && !Array.isArray(evt) ? evt.type : undefined, "run.progress");
  assert.equal(extractCodexSessionRef('{"type":"turn.started"}'), undefined);
  assert.equal(extractCodexSessionRef("not json"), undefined);
});

test("agent_message and reasoning map to message/thinking events (v6 §5)", () => {
  const msg = map('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}');
  assert.equal(msg && !Array.isArray(msg) ? msg.type : undefined, "agent.message");
  assert.equal(msg && !Array.isArray(msg) ? msg.data.content : undefined, "ok");

  const think = map('{"type":"item.completed","item":{"id":"item_r","type":"reasoning","text":"plan"}}');
  assert.equal(think && !Array.isArray(think) ? think.type : undefined, "agent.thinking");

  // Deltas before completion are not events.
  assert.equal(map('{"type":"item.started","item":{"id":"item_0","type":"agent_message"}}'), null);
});

test("command_execution maps to shell.command + shell.output (v6 §5)", () => {
  const started = map('{"type":"item.started","item":{"id":"c1","type":"command_execution","command":"npm test","status":"in_progress"}}');
  assert.equal(started && !Array.isArray(started) ? started.type : undefined, "shell.command");
  assert.equal(started && !Array.isArray(started) ? started.data.command : undefined, "npm test");

  const done = map('{"type":"item.completed","item":{"id":"c1","type":"command_execution","command":"npm test","aggregated_output":"3 passing","exit_code":0,"status":"completed"}}');
  assert.equal(done && !Array.isArray(done) ? done.type : undefined, "shell.output");
  assert.equal(done && !Array.isArray(done) ? done.data.exitCode : undefined, 0);
});

test("file_change maps one file event per changed path (v6 §5)", () => {
  const evts = map(
    '{"type":"item.completed","item":{"id":"f1","type":"file_change","changes":[{"path":"src/a.ts","kind":"add"},{"path":"src/b.ts","kind":"update"}],"status":"completed"}}'
  );
  assert.ok(Array.isArray(evts));
  assert.equal(evts.length, 2);
  assert.equal(evts[0].type, "file.created");
  assert.equal(evts[0].data.path, "src/a.ts");
  assert.equal(evts[1].type, "file.modified");
  assert.equal(evts[1].data.path, "src/b.ts");
});

test("mcp_tool_call and web_search map to tool events (v6 §5)", () => {
  const started = map('{"type":"item.started","item":{"id":"m1","type":"mcp_tool_call","server":"github","tool":"create_issue","arguments":{"title":"T"}}}');
  assert.equal(started && !Array.isArray(started) ? started.type : undefined, "tool.started");
  assert.equal(started && !Array.isArray(started) ? started.data.tool : undefined, "github/create_issue");

  const done = map('{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","server":"github","tool":"create_issue","result":{"issue":7}}}');
  assert.equal(done && !Array.isArray(done) ? done.type : undefined, "tool.completed");

  const search = map('{"type":"item.completed","item":{"id":"w1","type":"web_search","query":"node jsonl"}}');
  assert.equal(search && !Array.isArray(search) ? search.type : undefined, "tool.completed");
  assert.deepEqual(
    search && !Array.isArray(search) ? search.data.args : undefined,
    { query: "node jsonl" }
  );
  // Searches only appear at completion.
  assert.equal(map('{"type":"item.started","item":{"id":"w1","type":"web_search","query":"x"}}'), null);
});

test("turn.completed usage is authoritative and unmetered (v6 §5)", () => {
  const usage = parseCodexUsage(
    '{"type":"turn.completed","usage":{"input_tokens":17191,"cached_input_tokens":11904,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'
  );
  assert.deepEqual(
    usage && {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      modelRequests: usage.modelRequests,
      estimatedCost: usage.estimatedCost,
    },
    { inputTokens: 17191, outputTokens: 5, cachedTokens: 11904, reasoningTokens: 0, modelRequests: 1, estimatedCost: undefined }
  );
  assert.equal(parseCodexUsage('{"type":"turn.started"}'), undefined);
  assert.equal(parseCodexUsage("not json"), undefined);
});

test("failures keep their identity: turn.failed, error events, quota (v6 §10)", () => {
  const failed = map('{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again in 3 hours."}}');
  assert.equal(failed && !Array.isArray(failed) ? failed.type : undefined, "runtime.error");
  assert.equal(failed && !Array.isArray(failed) ? failed.data.usageLimit : undefined, true);

  const streamErr = map('{"type":"error","message":"stream error after 5 retries"}');
  assert.equal(streamErr && !Array.isArray(streamErr) ? streamErr.type : undefined, "runtime.error");

  // Transient reconnect notes are debug logs, not failures.
  const reconnect = map('{"type":"error","message":"Reconnecting... 1/5"}');
  assert.equal(reconnect && !Array.isArray(reconnect) ? reconnect.type : undefined, "log");

  assert.equal(detectCodexUsageLimit("You've hit your usage limit. Upgrade to Plus to continue."), true);
  assert.equal(detectCodexUsageLimit("usage limit reached"), true);
  assert.equal(detectCodexUsageLimit("ENOENT: no such file"), false);
});

test("unknown lines stay visible as raw debug events (v6 §5)", () => {
  const evt = map('{"type":"something.new","payload":1}');
  assert.equal(evt && !Array.isArray(evt) ? evt.type : undefined, "log");
  assert.equal(map("plain text line"), null);
});
