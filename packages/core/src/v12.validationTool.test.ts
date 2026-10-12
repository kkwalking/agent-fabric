/**
 * v12 §5.1 — the generated verdict tool, as a real process.
 *
 * The tool is the judge's only deterministic submission channel: a plain
 * Node script provisioning writes per run, invoked as
 * `node <tool> --passed|--failed --summary ... [--unmet ...] --evidence ...`.
 *
 * These tests run the **generated script with node**, not a re-implementation
 * of it: the contract (exit codes, files written, last-call-wins) must hold
 * for the artifact the judge actually receives. The script is `.mjs` and must
 * parse as an ES module wherever it lands — no package.json required.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { validationToolScript } from "./validationTool.js";

const execFileAsync = promisify(execFile);

interface ToolRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Materializes the generated tool into a fresh dir, then runs it. */
async function runTool(dir: string, args: string[]): Promise<ToolRun> {
  const tool = join(dir, "validation-tool.mjs");
  try {
    const { stdout, stderr } = await execFileAsync("node", [tool, ...args]);
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/**
 * A fresh directory holding the generated tool and its output directory —
 * with no package.json, exactly how a container sees it.
 */
function makeTool(): { dir: string; outputDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "af-tool-"));
  const outputDir = join(dir, "validation-output");
  writeFileSync(join(dir, "validation-tool.mjs"), validationToolScript(outputDir), { mode: 0o700 });
  return { dir, outputDir };
}

function readVerdict(outputDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(outputDir, "verdict.json"), "utf8")) as Record<string, unknown>;
}

describe("v12: the verdict tool (v12 §5.1)", () => {
  test("a valid passing verdict writes verdict.json and exits 0", async () => {
    const { dir, outputDir } = makeTool();
    const run = await runTool(dir, [
      "--passed",
      "--summary",
      "The acceptance standard is met.",
      "--evidence",
      "`go build ./...` → exit 0",
    ]);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /PASSED/);
    assert.deepEqual(readVerdict(outputDir), {
      passed: true,
      summary: "The acceptance standard is met.",
      unmet: [],
      evidence: ["`go build ./...` → exit 0"],
    });
  });

  test("a valid failing verdict requires --unmet and exits 0", async () => {
    const { dir, outputDir } = makeTool();
    const run = await runTool(dir, [
      "--failed",
      "--summary",
      "Two requirements are unmet.",
      "--unmet",
      "the build fails",
      "--unmet",
      "no test file exists",
      "--evidence",
      "`go build ./...` → exit 1",
    ]);

    assert.equal(run.exitCode, 0, run.stderr);
    const verdict = readVerdict(outputDir) as { passed: boolean; unmet: string[] };
    assert.equal(verdict.passed, false);
    assert.deepEqual(verdict.unmet, ["the build fails", "no test file exists"]);
  });

  test("an invalid payload exits 2 and writes nothing", async () => {
    const cases: Array<{ args: string[]; reason: RegExp }> = [
      { args: ["--summary", "x", "--evidence", "e"], reason: /--passed or --failed/ },
      { args: ["--passed", "--evidence", "e"], reason: /--summary/ },
      { args: ["--passed", "--summary", "x"], reason: /evidence/ },
      { args: ["--failed", "--summary", "x", "--evidence", "e"], reason: /unmet/ },
      { args: ["--passed", "--summary", "x", "--evidence", "e", "--bogus"], reason: /unknown argument/ },
    ];
    for (const { args, reason } of cases) {
      const { dir, outputDir } = makeTool();
      const run = await runTool(dir, args);
      assert.equal(run.exitCode, 2, `args ${args.join(" ")}: ${run.stderr}`);
      assert.match(run.stderr, reason, args.join(" "));
      assert.equal(existsSync(join(outputDir, "verdict.json")), false, `args ${args.join(" ")} wrote a verdict`);
    }
  });

  test("a corrected payload after an invalid one lands (the judge can retry itself)", async () => {
    const { dir, outputDir } = makeTool();
    const bad = await runTool(dir, ["--failed", "--summary", "nope", "--evidence", "e"]);
    assert.equal(bad.exitCode, 2);
    assert.equal(existsSync(join(outputDir, "verdict.json")), false);
    const good = await runTool(dir, ["--failed", "--summary", "nope", "--unmet", "missing", "--evidence", "e"]);
    assert.equal(good.exitCode, 0, good.stderr);
    assert.equal(existsSync(join(outputDir, "verdict.json")), true);
  });

  test("the last call wins and every call is audited in verdict-calls.jsonl", async () => {
    const { dir, outputDir } = makeTool();
    await runTool(dir, ["--failed", "--summary", "first try", "--unmet", "x", "--evidence", "e1"]);
    await runTool(dir, ["--passed", "--summary", "second try", "--evidence", "e2"]);

    const verdict = readVerdict(outputDir) as { passed: boolean; summary: string };
    assert.equal(verdict.passed, true, "the later call replaced the earlier verdict");
    assert.equal(verdict.summary, "second try");
    const calls = readFileSync(join(outputDir, "verdict-calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(calls.length, 2, "every call is on the audit trail");
    assert.equal((JSON.parse(calls[0]) as { verdict: { passed: boolean } }).verdict.passed, false);
    assert.equal((JSON.parse(calls[1]) as { verdict: { passed: boolean } }).verdict.passed, true);
  });

  test("the tool is a valid ES module wherever it is placed", async () => {
    // A container's working directory usually has no package.json; `.mjs`
    // must be enough on its own. (The original implementation used CJS
    // `require` inside a `.mjs` file and crashed on every invocation.)
    const { dir } = makeTool();
    assert.equal(existsSync(join(dir, "package.json")), false);
    const run = await runTool(dir, ["--passed", "--summary", "ok", "--evidence", "e"]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(run.stderr, "", "no module-system warning or error");
  });
});
