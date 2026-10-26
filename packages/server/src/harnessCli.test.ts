/**
 * Detection of the local harness CLIs (`./harnessCli.ts`).
 *
 * The behaviour under test is the one that made the board claim "no agent CLI
 * is installed" on a machine with five of them: the server's PATH is not the
 * user's PATH. A CLI installed by a package/version manager into a folder PATH
 * lacks is still found, still reports its version, and says its folder is not
 * on the terminal's PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AppConfig } from "@agentfabric/core";
import {
  HARNESS_CLIS,
  applyConfiguredHarnessBins,
  detectHarnessCli,
  ensureUserPath,
  forgetDetection,
  harnessCliSpec,
  loginShellPath,
  parseShellPath,
  parseVersion,
  pathDirs,
  userBinDirs,
} from "./harnessCli.js";

/** A directory this test owns, removed afterwards. */
function sandbox(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "af-harnesscli-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An executable file that prints `version` for `--version`. */
function fakeCli(dir: string, name: string, version: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} ${version}"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Runs `fn` with HOME and PATH replaced, restoring both afterwards. */
async function withEnv(
  env: { HOME?: string; PATH?: string; SHELL?: string },
  fn: () => Promise<void>
): Promise<void> {
  const saved = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    NVM_DIR: process.env.NVM_DIR,
    BUN_INSTALL: process.env.BUN_INSTALL,
    VOLTA_HOME: process.env.VOLTA_HOME,
  };
  try {
    if (env.HOME !== undefined) process.env.HOME = env.HOME;
    if (env.PATH !== undefined) process.env.PATH = env.PATH;
    if (env.SHELL !== undefined) process.env.SHELL = env.SHELL;
    // The managers' variables would point at the real machine's folders.
    delete process.env.NVM_DIR;
    delete process.env.BUN_INSTALL;
    delete process.env.VOLTA_HOME;
    forgetDetection();
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    forgetDetection();
  }
}

test("parseVersion takes the first version token of --version output", () => {
  assert.equal(parseVersion("codex-cli 0.163.0\n"), "0.163.0");
  assert.equal(parseVersion("2.1.128 (Claude Code)\n"), "2.1.128");
  assert.equal(parseVersion("opencode v2.0.21"), "2.0.21");
  assert.equal(parseVersion("dsh 0.2.1-rc.3"), "0.2.1-rc.3");
  assert.equal(parseVersion(""), "");
  assert.equal(parseVersion("no version here"), "");
});

test("parseShellPath reads the marked value, and rejects an unexpanded reference", () => {
  const mark = "__agentfabric_path__";
  assert.deepEqual(parseShellPath(`${mark}${["/usr/bin", "/opt/homebrew/bin"].join(delimiter)}${mark}`), [
    "/usr/bin",
    "/opt/homebrew/bin",
  ]);
  // A shell that printed the text instead of expanding it says nothing usable.
  assert.equal(parseShellPath(`${mark}$PATH${mark}`), null);
  assert.equal(parseShellPath("just a profile banner"), null);
});

test("userBinDirs only lists folders that exist, and includes the managers' own", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    for (const sub of [".local/bin", ".bun/bin", ".opencode/bin", ".nvm/versions/node/v22.15.0/bin"]) {
      mkdirSync(join(home, sub), { recursive: true });
    }
    await withEnv({ HOME: home }, async () => {
      const dirs = userBinDirs();
      assert.ok(dirs.includes(join(home, ".local/bin")), `missing ~/.local/bin in ${dirs.join(", ")}`);
      assert.ok(dirs.includes(join(home, ".bun/bin")));
      assert.ok(dirs.includes(join(home, ".opencode/bin")));
      assert.ok(dirs.includes(join(home, ".nvm/versions/node/v22.15.0/bin")));
      // A folder that does not exist is not offered as a place to look.
      assert.ok(!dirs.includes(join(home, ".npm-global/bin")));
    });
  } finally {
    box.done();
  }
});

test("nvm's default Node comes before the other versions", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    for (const version of ["v22.15.0", "v24.18.0"]) {
      mkdirSync(join(home, ".nvm/versions/node", version, "bin"), { recursive: true });
    }
    mkdirSync(join(home, ".nvm/alias"), { recursive: true });
    writeFileSync(join(home, ".nvm/alias/default"), "v22.15.0\n");
    await withEnv({ HOME: home }, async () => {
      const dirs = userBinDirs().filter((dir) => dir.includes("/.nvm/versions/node/"));
      assert.equal(dirs[0], join(home, ".nvm/versions/node/v22.15.0/bin"));
      assert.equal(dirs[1], join(home, ".nvm/versions/node/v24.18.0/bin"));
    });
  } finally {
    box.done();
  }
});

test("ensureUserPath appends the managers' folders to PATH once", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    const before = process.env.PATH;
    await withEnv({ HOME: home, PATH: "/usr/bin" }, async () => {
      ensureUserPath();
      ensureUserPath();
      const dirs = pathDirs();
      assert.equal(dirs[0], "/usr/bin");
      assert.equal(dirs.filter((dir) => dir === join(home, ".local/bin")).length, 1);
    });
    // Restored by withEnv, then checked here: PATH is process-wide state.
    assert.equal(process.env.PATH, before);
  } finally {
    box.done();
  }
});

test("a CLI on PATH is found there, and is not reported off the terminal's PATH", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    const bin = join(box.dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    fakeCli(bin, "codex", "0.163.0");
    await withEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" }, async () => {
      const spec = HARNESS_CLIS.find((entry) => entry.id === "codex")!;
      const found = await detectHarnessCli(spec, { probeVersion: true });
      assert.equal(found.path, join(bin, "codex"));
      assert.equal(found.source, "path");
      assert.equal(found.version, "0.163.0");
      // The login shell's PATH is whatever this machine's sh reports; the
      // answer is either "contains bin" or "could not be read", and neither is
      // "off PATH" — the CLI is on the PATH the process itself has.
      assert.equal(found.offPath, false);
    });
  } finally {
    box.done();
  }
});

test("a CLI in a manager's folder is found though PATH lacks it, and is reported off PATH", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    // What the Dock-launched app looks like: launchd's PATH, nothing else.
    const empty = join(box.dir, "empty");
    mkdirSync(home, { recursive: true });
    mkdirSync(empty, { recursive: true });
    const localBin = join(home, ".local/bin");
    mkdirSync(localBin, { recursive: true });
    const cli = fakeCli(localBin, "dsh", "0.2.1-rc.3");
    // A login shell whose PATH is the empty folder: the CLI is off it.
    const shell = join(box.dir, "fake-shell");
    writeFileSync(
      shell,
      `#!/bin/sh\nprintf '__agentfabric_path__%s__agentfabric_path__' "${empty}"\n`
    );
    chmodSync(shell, 0o755);
    await withEnv({ HOME: home, PATH: empty, SHELL: shell }, async () => {
      const spec = HARNESS_CLIS.find((entry) => entry.id === "dsh")!;
      const found = await detectHarnessCli(spec, { probeVersion: true });
      assert.equal(found.path, cli);
      assert.equal(found.source, "user-dirs");
      assert.equal(found.version, "0.2.1-rc.3");
      assert.equal(found.offPath, true, "a CLI outside the terminal's PATH must say so");
    });
  } finally {
    box.done();
  }
});

test("the login shell's own PATH is looked in, for a folder no fixed list knows", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    const empty = join(box.dir, "empty");
    const custom = join(box.dir, "custom-tools");
    for (const dir of [home, empty, custom]) mkdirSync(dir, { recursive: true });
    const cli = fakeCli(custom, "pi", "1.3.0");
    const shell = join(box.dir, "fake-shell");
    writeFileSync(shell, `#!/bin/sh\nprintf '__agentfabric_path__%s__agentfabric_path__' "${custom}"\n`);
    chmodSync(shell, 0o755);
    await withEnv({ HOME: home, PATH: empty, SHELL: shell }, async () => {
      const spec = HARNESS_CLIS.find((entry) => entry.id === "pi")!;
      const found = await detectHarnessCli(spec);
      assert.equal(found.path, cli);
      assert.equal(found.source, "login-shell");
      // Found *through* the shell's PATH, so it is on it.
      assert.equal(found.offPath, false);
    });
  } finally {
    box.done();
  }
});

test("a configured path wins over detection, and a broken one is reported, not skipped", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    const bin = join(box.dir, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    fakeCli(bin, "codex", "9.9.9");
    const chosen = fakeCli(bin, "codex-special", "1.2.3");
    await withEnv({ HOME: home, PATH: bin, SHELL: "/bin/sh" }, async () => {
      const spec = HARNESS_CLIS.find((entry) => entry.id === "codex")!;
      const configured: AppConfig = { codex: { bin: chosen } };
      const found = await detectHarnessCli(spec, { config: configured, probeVersion: true });
      assert.equal(found.path, chosen, "the configured path is not second-guessed");
      assert.equal(found.source, "configured");
      assert.equal(found.version, "1.2.3");

      const broken = await detectHarnessCli(spec, { config: { codex: { bin: join(bin, "nope") } } });
      assert.equal(broken.path, undefined);
      assert.match(broken.problem ?? "", /nope/);
    });
  } finally {
    box.done();
  }
});

test("a CLI that is nowhere is reported as missing, with no problem text", async () => {
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    const empty = join(box.dir, "empty");
    mkdirSync(home, { recursive: true });
    mkdirSync(empty, { recursive: true });
    const shell = join(box.dir, "fake-shell");
    writeFileSync(shell, "#!/bin/sh\nprintf '__agentfabric_path__%s__agentfabric_path__' '/nonexistent'\n");
    chmodSync(shell, 0o755);
    await withEnv({ HOME: home, PATH: empty, SHELL: shell }, async () => {
      const spec = HARNESS_CLIS.find((entry) => entry.id === "claude")!;
      const found = await detectHarnessCli(spec);
      assert.equal(found.path, undefined);
      assert.equal(found.problem, undefined);
      assert.equal(found.offPath, false);
    });
  } finally {
    box.done();
  }
});

test("detection does not run the CLI unless a version was asked for", async () => {
  // The board's start path runs detection on every card start. Spawning
  // `<cli> --version` there would start the agent's binary for nothing — and an
  // ACP/TUI binary started that way is a live process the board never wanted
  // (it broke the ACP session tests: a second `dsh` was started per card).
  const box = sandbox();
  try {
    const home = join(box.dir, "home");
    const localBin = join(home, ".local/bin");
    mkdirSync(localBin, { recursive: true });
    const calls = join(box.dir, "calls");
    const cli = join(localBin, "codex");
    writeFileSync(cli, `#!/bin/sh\necho x >> "${calls}"\necho "codex-cli 0.1.0"\n`);
    chmodSync(cli, 0o755);
    await withEnv({ HOME: home, PATH: join(box.dir, "empty"), SHELL: "/bin/sh" }, async () => {
      mkdirSync(join(box.dir, "empty"), { recursive: true });
      const spec = HARNESS_CLIS.find((entry) => entry.id === "codex")!;
      const quiet = await detectHarnessCli(spec);
      assert.equal(quiet.path, cli);
      assert.equal(quiet.version, undefined, "no version without being asked");
      assert.equal(existsSync(calls), false, "the CLI must not have been started");
      // Asked for, it is started once and its answer is used.
      const loud = await detectHarnessCli(spec, { probeVersion: true, refresh: true });
      assert.equal(loud.version, "0.1.0");
      assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    });
  } finally {
    box.done();
  }
});

test("applyConfiguredHarnessBins writes the adapters' variables, and gives them back", async () => {
  const saved = { AGENTFABRIC_CODEX_BIN: process.env.AGENTFABRIC_CODEX_BIN };
  try {
    delete process.env.AGENTFABRIC_CODEX_BIN;
    const applied = applyConfiguredHarnessBins({ codex: { bin: "/opt/x/codex" } });
    assert.deepEqual(applied, ["AGENTFABRIC_CODEX_BIN=/opt/x/codex"]);
    assert.equal(process.env.AGENTFABRIC_CODEX_BIN, "/opt/x/codex");

    // The file no longer sets it: the value this process wrote goes away.
    applyConfiguredHarnessBins({});
    assert.equal(process.env.AGENTFABRIC_CODEX_BIN, undefined);

    // A variable somebody else set is never overwritten by the file.
    process.env.AGENTFABRIC_CODEX_BIN = "/operator/codex";
    assert.deepEqual(applyConfiguredHarnessBins({ codex: { bin: "/file/codex" } }), []);
    assert.equal(process.env.AGENTFABRIC_CODEX_BIN, "/operator/codex");
  } finally {
    if (saved.AGENTFABRIC_CODEX_BIN === undefined) delete process.env.AGENTFABRIC_CODEX_BIN;
    else process.env.AGENTFABRIC_CODEX_BIN = saved.AGENTFABRIC_CODEX_BIN;
  }
});

test("the catalog names the same commands the adapters run", () => {
  assert.deepEqual(
    HARNESS_CLIS.map((spec) => spec.command),
    ["claude", "codex", "opencode", "pi", "dsh"]
  );
  assert.equal(harnessCliSpec("claude")?.configKey, "claudeCode");
  assert.equal(harnessCliSpec("dsh")?.envVar, "AGENTFABRIC_DSH_BIN");
  assert.equal(harnessCliSpec("not-a-harness"), undefined);
});

test("loginShellPath is cached, and reports the shell it asked", async () => {
  const box = sandbox();
  try {
    const shell = join(box.dir, "fake-shell");
    const calls = join(box.dir, "calls");
    writeFileSync(
      shell,
      `#!/bin/sh\necho x >> "${calls}"\nprintf '__agentfabric_path__/usr/bin__agentfabric_path__'\n`
    );
    chmodSync(shell, 0o755);
    await withEnv({ SHELL: shell }, async () => {
      const first = await loginShellPath();
      assert.equal(first.shell, shell);
      assert.deepEqual(first.dirs, ["/usr/bin"]);
      await loginShellPath();
      // One question, two answers: the second came from the cache.
      assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
      // A refresh asks again.
      await loginShellPath({ refresh: true });
      assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
    });
  } finally {
    box.done();
  }
});
