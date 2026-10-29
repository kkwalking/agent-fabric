/**
 * The task thread's projector: run events → timeline rows.
 *
 * The bug this guards: a shell tool is projected from `shell.command` +
 * `shell.output`, and only the run ending ever closed the row — so every
 * command spun until the turn was over, while `tool.started`/`tool.completed`
 * rows (read, write, …) finished normally. The close signal is the terminal
 * `shell.output` a harness emits with its result, and it carries the verdict
 * (completed / failed).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTimeline, type RawEvent } from "../src/presentation.js";

/** The projector only translates tool verbs; keys are enough here. */
const t = ((key: string) => key) as never;

let seq = 0;
function ev(type: string, data: Record<string, unknown> = {}): RawEvent {
  seq += 1;
  return { id: `evt_${seq}`, runId: "run_x", seq, type, timestamp: new Date().toISOString(), data };
}

/** Every run opens with the harness launch command; it is never a row. */
const launch = () => ev("shell.command", { command: "pi --print …", harnessInvocation: true });

function rows(events: RawEvent[], live: boolean) {
  return projectTimeline(t, events, { live });
}

test("a finished command closes while the run is still going", () => {
  const items = rows(
    [
      launch(),
      ev("shell.command", { command: "npm test", toolCallId: "call_1" }),
      ev("shell.output", { output: "3 passing", status: "completed", toolCallId: "call_1" }),
    ],
    true
  );
  assert.equal(items.length, 1);
  const command = items[0];
  if (command.kind !== "command") throw new Error("expected a command row");
  assert.equal(command.status, "done");
  assert.deepEqual(command.outputs, ["3 passing"]);
  assert.equal(command.summary, "✓ 3 passing");
  assert.equal(command.summaryOk, true);
});

test("a failed command reports its own verdict, not the output heuristic", () => {
  const items = rows(
    [
      launch(),
      ev("shell.command", { command: "npm test", toolCallId: "call_1" }),
      // Output that reads like success; the exit status says otherwise.
      ev("shell.output", { output: "3 passing", status: "failed", toolCallId: "call_1" }),
    ],
    true
  );
  const command = items[0];
  if (command.kind !== "command") throw new Error("expected a command row");
  assert.equal(command.status, "error");
  assert.equal(command.summaryOk, false);
});

test("a command that is still streaming keeps spinning", () => {
  const items = rows(
    [
      launch(),
      ev("shell.command", { command: "npm test", toolCallId: "call_1" }),
      ev("shell.output", { line: "running 1 of 3", stream: "stdout" }),
    ],
    true
  );
  const command = items[0];
  if (command.kind !== "command") throw new Error("expected a command row");
  assert.equal(command.status, "running");
  assert.deepEqual(command.outputs, ["running 1 of 3"]);
});

test("a terminal output closes only the command it names", () => {
  const items = rows(
    [
      launch(),
      ev("shell.command", { command: "first", toolCallId: "call_a" }),
      ev("shell.command", { command: "second", toolCallId: "call_b" }),
      ev("shell.output", { output: "first done", status: "completed", toolCallId: "call_a" }),
    ],
    true
  );
  assert.equal(items.length, 2);
  const [first, second] = items;
  if (first.kind !== "command" || second.kind !== "command") throw new Error("expected two command rows");
  assert.equal(first.status, "done");
  assert.equal(second.status, "running");
});

test("a run that ended closes what the harness left open", () => {
  const items = rows([launch(), ev("shell.command", { command: "npm test" })], false);
  const command = items[0];
  if (command.kind !== "command") throw new Error("expected a command row");
  assert.equal(command.status, "done");
});

test("the harness launch command is not an activity row", () => {
  const items = rows(
    [
      launch(),
      ev("shell.command", { command: "npm test", toolCallId: "call_1" }),
      ev("shell.output", { output: "3 passing", status: "completed", toolCallId: "call_1" }),
    ],
    true
  );
  assert.equal(items.length, 1);
  const command = items[0];
  if (command.kind !== "command") throw new Error("expected a command row");
  assert.equal(command.command, "npm test");
});

test("tool rows keep their own lifecycle", () => {
  const items = rows(
    [
      launch(),
      ev("tool.started", { tool: "read", toolCallId: "call_read", args: { file_path: "a.ts" } }),
      ev("tool.started", { tool: "read", toolCallId: "call_read_2", args: { file_path: "b.ts" } }),
      ev("tool.completed", { tool: "read", toolCallId: "call_read", result: "…" }),
    ],
    true
  );
  assert.equal(items.length, 2);
  const [done, open] = items;
  if (done.kind !== "tool" || open.kind !== "tool") throw new Error("expected two tool rows");
  assert.equal(done.status, "done");
  assert.equal(open.status, "running");
});
