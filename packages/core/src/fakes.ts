/**
 * Realistic fake harness CLIs + fake docker shim shared by the v2/v3
 * test suites (v3 §3: fakes must model *real* harness behavior).
 *
 * The fakes implement the verified wire protocols of the real tools:
 *
 * - fake pi: `--mode json` event stream (session header, agent/turn/
 *   message lifecycle, tool_execution_* events, per-message usage) and
 *   a session store at $PI_CODING_AGENT_DIR/sessions/<cwd-slug>/ that
 *   `--session <id>` really reads. A fresh run (no `--no-session`)
 *   *persists* the session; resuming an id that is not on disk fails
 *   with a non-zero exit — exactly like the real CLI.
 *
 * - fake opencode: `run --format json` envelope ({type, timestamp,
 *   sessionID, …}) with step_start / text / tool_use / step_finish /
 *   error events, tokens+cost on step_finish, and a session store at
 *   $XDG_DATA_HOME/opencode/storage/session/ that `--session <id>`
 *   really reads; unknown sessions exit non-zero.
 *
 * - fake docker: parses `docker run …` argv, records it, writes the
 *   cidfile and executes the in-container command locally while
 *   emulating the bind mounts the real executor performs:
 *     /root/.pi                    → PI_CODING_AGENT_DIR=<host>/agent
 *     /root/.local/share/opencode  → XDG_DATA_HOME=<tmp>/ (symlink
 *                                    `opencode` → host dir)
 *     /workspace                   → process cwd = host workspace
 *
 * So a containerized fake run only native-resumes when the opaque
 * native state really contains the session — mount the wrong state and
 * the harness fails, just like the real CLIs.
 */

export const FAKE_PI_SCRIPT = `#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);

// E2E observability (v4 §26–§29): dump what the harness process actually
// received — env (whitelisted), argv and the generated models.json.
if (process.env.FAKE_HARNESS_DUMP) {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
  let modelsJson;
  try { modelsJson = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")); } catch {}
  appendFileSync(process.env.FAKE_HARNESS_DUMP, JSON.stringify({
    harness: "pi",
    argv: args,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD", "OLDPWD", "SHLVL", "LANG", "TERM", "_"].includes(k) && !k.startsWith("npm_") && !k.startsWith("NPM_"))),
    modelsJson,
    cwd: process.cwd(),
  }) + "\\n");
}

// Optional slow mode: hold the run open so cancel/timeout tests can abort
// a genuinely-running harness process (never longer than 60s).
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS ?? 0);
if (sleepMs > 0) {
  await new Promise((r) => setTimeout(r, Math.min(sleepMs, 60_000)));
}

const prompt = args.filter((a) => !a.startsWith("-") && !["run", "--print"].includes(a)).pop() ?? "";
const sessionIdx = args.indexOf("--session");
const resumeId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;
const noSession = args.includes("--no-session");

// Real pi keeps sessions under $PI_CODING_AGENT_DIR/sessions/<cwd-slug>/.
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "/tmp", ".pi", "agent");
const sessionsRoot = join(agentDir, "sessions");
const slug = "--" + process.cwd().replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
const sessionDir = join(sessionsRoot, slug);
const emit = (o) => console.log(JSON.stringify(o));

let session = null;
if (resumeId) {
  // Resume: the session must really exist in the store, else fail hard
  // (real pi exits non-zero for unknown sessions).
  let file = null;
  if (existsSync(sessionsRoot)) {
    for (const dir of readdirSync(sessionsRoot)) {
      const hit = readdirSync(join(sessionsRoot, dir)).find((f) => f.replace(/\\.jsonl$/, "").includes(resumeId));
      if (hit) { file = join(sessionsRoot, dir, hit); break; }
    }
  }
  if (!file) {
    console.error("Session not found: " + resumeId);
    process.exit(1);
  }
  session = JSON.parse(readFileSync(file, "utf8"));
  session.entries.push(prompt);
  writeFileSync(file, JSON.stringify(session));
} else if (!noSession) {
  // Fresh run in normal session mode: create AND persist the session.
  session = { id: randomUUID(), cwd: process.cwd(), entries: [prompt] };
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, session.id + ".jsonl"), JSON.stringify(session));
}

const id = session ? session.id : randomUUID();
const firstEntry = session ? session.entries[0] : null;
const reply = session && resumeId
  ? "pi resumed session " + id + '; prior context: "' + firstEntry + '"'
  : "pi fresh session " + id;

emit({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() });
emit({ type: "agent_start" });
emit({ type: "turn_start" });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
emit({
  type: "message_update",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply.slice(0, 5) },
});
// One tool round, exactly like a real coding turn.
emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
emit({ type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: { command: "ls" }, partialResult: "READ" });
emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { output: "README.md src" }, isError: false });
const usage1 = { input: 525, output: 64, cacheRead: 1200, cacheWrite: 80, reasoning: 0, totalTokens: 1869, cost: { input: 0.0012, output: 0.0007, cacheRead: 0.0001, cacheWrite: 0.0001, total: 0.0021 } };
const toolMsg = { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }], model: "fake-pi-model", usage: usage1, stopReason: "toolUse", timestamp: new Date().toISOString() };
emit({ type: "message_end", message: toolMsg });
emit({ type: "turn_end", message: toolMsg, toolResults: [{ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: "README.md src", isError: false }] });
emit({ type: "turn_start" });
emit({ type: "message_start", message: { role: "assistant", content: [] } });
const usage2 = { input: 1100, output: 96, cacheRead: 800, cacheWrite: 0, reasoning: 32, totalTokens: 2028, cost: { input: 0.0022, output: 0.0011, cacheRead: 0.0001, cacheWrite: 0, total: 0.0034 } };
const textMsg = { role: "assistant", content: [{ type: "thinking", thinking: "listing files first" }, { type: "text", text: reply }], model: "fake-pi-model", usage: usage2, stopReason: "stop", timestamp: new Date().toISOString() };
emit({ type: "message_end", message: textMsg });
emit({ type: "turn_end", message: textMsg, toolResults: [] });
emit({ type: "agent_end", messages: [toolMsg, textMsg], willRetry: false });
`;

export const FAKE_OPENCODE_SCRIPT = `#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

// E2E observability (v4 §26–§29): dump what the harness process actually
// received — env (whitelisted), argv and the generated OPENCODE_CONFIG.
if (process.env.FAKE_HARNESS_DUMP) {
  let config;
  try { config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, "utf8")); } catch {}
  appendFileSync(process.env.FAKE_HARNESS_DUMP, JSON.stringify({
    harness: "opencode",
    argv: args,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      !["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "PWD", "OLDPWD", "SHLVL", "LANG", "TERM", "_"].includes(k) && !k.startsWith("npm_") && !k.startsWith("NPM_"))),
    config,
    cwd: process.cwd(),
  }) + "\\n");
}

const prompt = args.filter((a) => !a.startsWith("-")).pop() ?? "";

// Optional slow mode: hold the run open so cancel/timeout tests can abort
// a genuinely-running harness process (never longer than 60s).
const ocSleepMs = Number(process.env.FAKE_OC_SLEEP_MS ?? 0);
if (ocSleepMs > 0) {
  await new Promise((r) => setTimeout(r, Math.min(ocSleepMs, 60_000)));
}
const sessionIdx = args.indexOf("--session");
const resumeId = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

// Real opencode keeps state at $XDG_DATA_HOME/opencode (fallback
// ~/.local/share/opencode); sessions under storage/session/.
const data = join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"), "opencode");
const sessionDir = join(data, "storage", "session");
const sid = () => "ses_" + Array.from({ length: 26 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("");
const ts = () => Date.now();
const emit = (type, data) => console.log(JSON.stringify({ type, timestamp: ts(), sessionID: id, ...data }));

let record = null;
let id;
if (resumeId) {
  const file = join(sessionDir, resumeId + ".json");
  if (!existsSync(file)) {
    id = sid();
    console.log(JSON.stringify({ type: "error", timestamp: ts(), sessionID: id, error: { name: "NotFoundError", data: { message: "Session not found: " + resumeId } } }));
    process.exit(1);
  }
  record = JSON.parse(readFileSync(file, "utf8"));
  record.entries.push(prompt);
  writeFileSync(file, JSON.stringify(record));
  id = record.id;
} else {
  id = sid();
  record = { id, entries: [prompt] };
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, id + ".json"), JSON.stringify(record));
}

const firstEntry = record.entries[0];
const reply = resumeId
  ? "opencode resumed session " + id + '; prior context: "' + firstEntry + '"'
  : "opencode fresh session " + id;

emit("step_start", { part: { type: "step-start" } });
emit("text", { part: { type: "text", text: reply, time: { start: ts(), end: ts() } } });
emit("tool_use", { part: { type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "README.md src", title: "Bash", metadata: { exit: 0 }, time: { start: ts(), end: ts() } } } });
emit("step_finish", { part: { type: "step-finish", reason: "stop", cost: 0.0031, tokens: { total: 2450, input: 1200, output: 300, reasoning: 50, cache: { read: 800, write: 100 } } } });
`;

export const FAKE_DOCKER_SCRIPT = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");

const VALUE_FLAGS = new Set([
  "--name", "--cidfile", "-w", "--workdir", "-e", "--env", "-v", "--volume",
  "--cpus", "--memory", "--pids-limit", "--network", "--label", "--entrypoint", "--user", "-u",
]);

// Mount emulation: translate the bind mounts the real executor would
// perform into the env/cwd the harness CLIs actually honor.
function mountsToEnv(volumes) {
  const env = {};
  let workspaceHost;
  for (const vol of volumes) {
    const [host, container] = vol.split(":");
    if (container === "/root/.pi") {
      env.PI_CODING_AGENT_DIR = host + "/agent";
    } else if (container === "/root/.local/share/opencode") {
      // XDG_DATA_HOME/<opencode> must resolve to the mounted host dir.
      const alt = mkdtempSync(join(tmpdir(), "af-xdg-"));
      try { symlinkSync(host, join(alt, "opencode")); } catch {}
      env.XDG_DATA_HOME = alt;
    } else if (container === "/workspace") {
      workspaceHost = host;
    } else if (container === "/root/.agentfabric/opencode.json") {
      // The generated harness config (v4 §1) is mounted read-only; point
      // the harness env back at the host file.
      env.OPENCODE_CONFIG = host;
    }
  }
  return { env, workspaceHost };
}

function passthrough(command, extraEnv, cidfile, cwd) {
  const cid = "fakectr_" + Math.random().toString(36).slice(2, 10);
  if (cidfile) { try { writeFileSync(cidfile, cid); } catch {} }
  const child = spawn(command[0], command.slice(1), {
    env: { ...process.env, ...extraEnv },
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Pipe (not inherit): when this fake docker CLI is killed, its stdout
  // pipe write-end closes and the caller sees EOF — like the real docker
  // CLI — instead of an orphaned grandchild holding the pipe open.
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));
  child.on("error", (err) => { console.error(String(err)); process.exit(127); });
  child.on("close", (code) => process.exit(code ?? 0));
}

const sub = args[0];
if (sub === "run" || sub === "exec") {
  const detached = args.includes("-d");
  const extraEnv = {};
  const volumes = [];
  let cidfile;
  let workdir;
  let firstPositional;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { firstPositional = i + 1; break; }
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) {
        const v = args[++i];
        if (a === "-e" || a === "--env") {
          const idx = v.indexOf("=");
          extraEnv[v.slice(0, idx)] = v.slice(idx + 1);
        } else if (a === "--cidfile") {
          cidfile = v;
        } else if (a === "-v" || a === "--volume") {
          volumes.push(v);
        } else if (a === "-w" || a === "--workdir") {
          workdir = v;
        }
      }
      continue;
    }
    firstPositional = i;
    break;
  }
  // run: <image> <command…>   exec: <container> <command…>
  const command = args.slice((firstPositional ?? args.length - 1) + 1);

  // Emulated in-container process kill (v4 §23): record that the platform
  // stopped the harness process inside the container, then succeed.
  if (command[0] === "pkill") {
    process.exit(0);
  }

  // Detached containers (keep-alive creation): a real daemon would start
  // "sh -c sleep infinity" in the background; just materialize a
  // container id and return.
  if (detached) {
    const cid = "fakectr_" + Math.random().toString(36).slice(2, 10);
    if (cidfile) { try { writeFileSync(cidfile, cid); } catch {} }
    console.log(cid);
    process.exit(0);
  }

  const { env: mountEnv, workspaceHost } = mountsToEnv(volumes);
  const cwd = workspaceHost && (!workdir || workdir === "/workspace") ? workspaceHost : undefined;
  passthrough(command, { ...extraEnv, ...mountEnv }, cidfile, cwd);
} else if (sub === "inspect") {
  console.log("true");
}
// ps / rm / start: succeed silently.
`;
