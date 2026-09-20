/**
 * Unit tests for the dsh-headless mapper — the protocol shapes captured
 * from real `dsh --profile headless --json` runs (dsh 0.1.6-alpha.1):
 * session opener, status phases with per-step usage, committed
 * text/thinking messages, tool_call/tool_result pairs, final bookkeeping,
 * out-of-turn error events.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDshSessionRef,
  mapDshEvent,
  newDshEventMapperState,
  parseDshUsage,
} from "./dsh.js";

let seqCounter = 0;
const seq = () => ++seqCounter;
const map = (line: string, state = newDshEventMapperState()) => mapDshEvent(line, "run_x", seq, state);
const first = (line: string, state = newDshEventMapperState()) => {
  const out = map(line, state);
  return Array.isArray(out) ? out[0] : out;
};

test("session opener yields the native session reference", () => {
  const raw = '{"type":"session","sessionId":"session-83011a67-096b-4636-b7c4-1587de56cb06","cwd":"/tmp/proj"}';
  assert.equal(extractDshSessionRef(raw), "session-83011a67-096b-4636-b7c4-1587de56cb06");
  const evt = map(raw);
  assert.equal(evt && !Array.isArray(evt) ? evt.type : undefined, "run.progress");
  assert.equal(evt && !Array.isArray(evt) ? evt.data.sessionId : undefined, "session-83011a67-096b-4636-b7c4-1587de56cb06");
  assert.equal(map("not json"), null);
  assert.equal(extractDshSessionRef("not json"), undefined);
});

test("status phases map to run progress; step_end usage parses once per request", () => {
  const start = first('{"type":"status","phase":"turn_start","turn":1}');
  assert.equal(start?.type, "run.progress");
  const stepEnd = first(
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":546,"outputTokens":72,"totalTokens":7274,"cacheReadTokens":6656}}'
  );
  assert.equal(stepEnd?.type, "run.progress");
  assert.equal(stepEnd?.data.phase, "step_end");
  const usage = parseDshUsage(
    '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":546,"outputTokens":72,"totalTokens":7274,"cacheReadTokens":6656}}'
  );
  assert.deepEqual(
    { input: usage?.inputTokens, output: usage?.outputTokens, cached: usage?.cachedTokens, requests: usage?.modelRequests },
    { input: 546, output: 72, cached: 6656, requests: 1 }
  );
  // Non-usage events yield no usage; usage must not be read from
  // turn_start.
  assert.equal(parseDshUsage('{"type":"status","phase":"turn_start","turn":1}'), undefined);
  const turnEnd = first('{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}');
  assert.equal(turnEnd?.type, "run.progress");
  assert.deepEqual(turnEnd?.data.reason, { kind: "completed" });
});

test("committed text and thinking map to message/thinking; final is bookkeeping only", () => {
  const text = first('{"type":"text","text":"I\'ll create the file."}');
  assert.equal(text?.type, "agent.message");
  assert.equal(text?.data.content, "I'll create the file.");
  assert.equal(text?.data.role, "assistant");
  const thinking = first('{"type":"thinking","text":"Verify content quickly."}');
  assert.equal(thinking?.type, "agent.thinking");
  assert.equal(thinking?.data.content, "Verify content quickly.");
  // final repeats the last committed message — emitting it as
  // agent.message would duplicate the answer.
  const final = first('{"type":"final","text":"Done."}');
  assert.equal(final?.type, "run.progress");
  assert.equal(final?.data.phase, "final");
  assert.equal(map('{"type":"text","text":"   "}'), null);
});

test("bash tool_call maps to shell.command, its result to shell.output", () => {
  const state = newDshEventMapperState();
  const started = first('{"type":"tool_call","callId":"c1","tool":"bash","input":{"command":"npm test"}}', state);
  assert.equal(started?.type, "shell.command");
  assert.equal(started?.data.command, "npm test");
  assert.equal(started?.data.toolCallId, "c1");

  const done = first('{"type":"tool_result","callId":"c1","status":"completed","result":"3 passing"}', state);
  assert.equal(done?.type, "shell.output");
  assert.equal(done?.data.output, "3 passing");
  assert.equal(done?.data.isError, false);
});

test("write/edit tool results map to file activity plus tool lifecycle", () => {
  const state = newDshEventMapperState();
  const writeStart = first(
    '{"type":"tool_call","callId":"w1","tool":"write","input":{"file_path":"src/new.ts","content":"x"}}',
    state
  );
  assert.equal(writeStart?.type, "tool.started");
  assert.equal(writeStart?.data.tool, "write");

  const writeDone = map('{"type":"tool_result","callId":"w1","status":"completed","result":"Created file"}', state);
  assert.ok(Array.isArray(writeDone));
  assert.equal(writeDone[0].type, "file.created");
  assert.equal(writeDone[0].data.path, "src/new.ts");
  assert.equal(writeDone[1].type, "tool.completed");

  const editDone = first(
    '{"type":"tool_result","callId":"unknown-call","status":"completed","result":"updated"}',
    state
  );
  // A result whose call was not seen still completes as a generic tool.
  assert.equal(Array.isArray(editDone) ? editDone[0].type : editDone?.type, "tool.completed");
});

test("generic tools pair through the mapper state; non-completed results are errors", () => {
  const state = newDshEventMapperState();
  const started = first('{"type":"tool_call","callId":"g1","tool":"read","input":{"file_path":"a.ts"}}', state);
  assert.equal(started?.type, "tool.started");
  assert.equal(started?.data.tool, "read");
  const done = first('{"type":"tool_result","callId":"g1","status":"failed","result":"boom"}', state);
  assert.equal(done?.type, "tool.completed");
  assert.equal(done?.data.isError, true);
  assert.equal(done?.data.tool, "read");
});

test("error events keep their message; unknown types stay as raw debug", () => {
  const err = first('{"type":"error","message":"profile headless does not exist"}');
  assert.equal(err?.type, "runtime.error");
  assert.equal(err?.data.error, "profile headless does not exist");
  const unknown = first('{"type":"workflow_started","id":"wf_1"}');
  assert.equal(unknown?.type, "log");
  assert.equal(unknown?.level, "debug");
});
