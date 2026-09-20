/**
 * Unit tests for the temp-directory constraint shared by every local
 * thread source: sessions recorded under /tmp, /var/tmp or the OS temp
 * dir are discovery noise and never listed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { isTempDirPath } from "./tempDirs.js";

test("classifies temp roots and their children in literal and resolved form", () => {
  assert.equal(isTempDirPath("/tmp"), true);
  assert.equal(isTempDirPath("/tmp/proj"), true);
  // macOS /tmp is a symlink to /private/tmp — both forms are temp.
  assert.equal(isTempDirPath("/private/tmp/proj"), true);
  assert.equal(isTempDirPath("/var/tmp/scratch"), true);
  assert.equal(isTempDirPath(tmpdir() + "/probe"), true);
});

test("real workspaces and unclassifiable paths are not temp", () => {
  assert.equal(isTempDirPath("/home/work/proj"), false);
  assert.equal(isTempDirPath("/Users/zhouzekun/code/agent-fabric"), false);
  // A directory that merely contains "tmp" as a name segment is not the
  // temp directory.
  assert.equal(isTempDirPath("/home/work/tmp"), false);
  assert.equal(isTempDirPath("/home/tmpfiles/proj"), false);
  // Relative paths carry no absolute location to judge.
  assert.equal(isTempDirPath("tmp/proj"), false);
  assert.equal(isTempDirPath(""), false);
});
