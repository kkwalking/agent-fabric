import test from "node:test";
import assert from "node:assert/strict";
import { TerminalSession } from "./kanban/terminal.js";

/** Wait for a session to exit, failing loudly instead of hanging the suite. */
function waitForExit(session: TerminalSession, timeoutMs = 5_000): Promise<{ exitCode: number; signal?: number }> {
  if (!session.running) return Promise.resolve(session.exit ?? { exitCode: 0 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal ${session.id} did not exit in ${timeoutMs}ms`)), timeoutMs);
    session.once("exit", (event: { exitCode: number; signal?: number }) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

function waitForOutput(session: TerminalSession, needle: string, timeoutMs = 5_000): Promise<string> {
  let seen = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not see ${JSON.stringify(needle)}; saw ${JSON.stringify(seen)}`)), timeoutMs);
    session.on("data", (chunk: string) => {
      seen += chunk;
      if (seen.includes(needle)) {
        clearTimeout(timer);
        resolve(seen);
      }
    });
  });
}

test("PTY streams output, keeps the exit code, and snapshots bytes", async () => {
  const session = new TerminalSession({
    id: "test-echo",
    file: "/bin/sh",
    args: ["-c", "printf 'hello-'; printf 'pty'"],
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
  });
  try {
    const seen = await waitForOutput(session, "hello-pty");
    assert.match(seen, /hello-pty/);
    const exit = await waitForExit(session);
    assert.equal(exit.exitCode, 0);
    assert.equal(session.running, false);

    const snapshot = session.snapshot();
    const replayed = Buffer.from(snapshot.data).toString("utf8");
    assert.match(replayed, /hello-pty/);
    assert.equal(snapshot.cols, 100);
    assert.equal(snapshot.rows, 30);
    assert.equal(snapshot.running, false);
  } finally {
    session.stop();
  }
});

test("a non-zero exit is reported as the process exit code", async () => {
  const session = new TerminalSession({
    id: "test-exit-code",
    file: "/bin/sh",
    args: ["-c", "exit 7"],
    cwd: process.cwd(),
  });
  const exit = await waitForExit(session);
  assert.equal(exit.exitCode, 7);
});

test("resize is forwarded to the PTY and reflected in the snapshot", async () => {
  const session = new TerminalSession({
    id: "test-resize",
    file: "/bin/sh",
    args: ["-c", "printf 'ready'; sleep 0.2"],
    cwd: process.cwd(),
  });
  try {
    await waitForOutput(session, "ready");
    session.resize(132, 43);
    assert.equal(session.cols, 132);
    assert.equal(session.rows, 43);
    const snapshot = session.snapshot();
    assert.equal(snapshot.cols, 132);
    // While the process is still alive the snapshot says so.
    assert.equal(snapshot.running, true);
    await waitForExit(session);
  } finally {
    session.stop();
  }
});

test("stop terminates the whole process group instead of leaving orphans", async () => {
  const session = new TerminalSession({
    id: "test-stop",
    file: "/bin/sh",
    args: ["-c", "printf 'started'; sleep 30"],
    cwd: process.cwd(),
  });
  await waitForOutput(session, "started");
  const exit = waitForExit(session, 3_000);
  session.stop("SIGTERM");
  const result = await exit;
  // node-pty reports a signalled process as exitCode 0 + signal 15 on Unix;
  // either field proves the process was terminated rather than finishing.
  assert.ok(result.exitCode !== 0 || result.signal !== undefined, "a SIGTERM'd process must not look like a clean exit");
  assert.equal(session.running, false);
});

test("scrollback is bounded and keeps the newest bytes", async () => {
  const session = new TerminalSession({
    id: "test-ring",
    file: "/bin/sh",
    args: ["-c", "printf 'AAAA'; printf 'BBBB'; printf 'CCCC'"],
    cwd: process.cwd(),
    scrollbackBytes: 4,
  });
  await waitForExit(session);
  const replayed = Buffer.from(session.snapshot().data).toString("utf8");
  assert.equal(replayed.length, 4);
  assert.equal(replayed, "CCCC");
});
