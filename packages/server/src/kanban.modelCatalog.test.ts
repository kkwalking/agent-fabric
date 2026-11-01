import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeModelsFromSettings,
  flattenModelOptions,
  parseOpenCodeModels,
  parsePiModels,
  pollListingUntilSettled,
} from "./kanban/modelCatalog.js";

test("flattenModelOptions keeps provider groups and exact values", () => {
  const models = flattenModelOptions({
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [{ value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" }],
      },
      { value: '["flat","model"]', name: "Flat model" },
    ],
  });
  assert.deepEqual(models, [
    {
      value: '["deepseek-official","deepseek-v4-pro"]',
      label: "DeepSeek-V4-Pro",
      group: "DeepSeek",
    },
    { value: '["flat","model"]', label: "Flat model" },
  ]);
});

test("flattenModelOptions returns no rows for an absent option", () => {
  assert.deepEqual(flattenModelOptions(undefined), []);
  assert.deepEqual(flattenModelOptions({}), []);
});

test("parsePiModels reads the fixed-width provider/model table", () => {
  const models = parsePiModels(
    [
      "provider  model                     context  max-out  thinking  images",
      "magpie    group/flash               1.0M     393.2K   yes       yes   ",
      "moark     deepseek-v4.1-flash       1M       384K     yes       no    ",
    ].join("\n")
  );
  assert.deepEqual(models, [
    { value: "magpie/group/flash", label: "group/flash", group: "magpie" },
    { value: "moark/deepseek-v4.1-flash", label: "deepseek-v4.1-flash", group: "moark" },
  ]);
});

test("parseOpenCodeModels reads provider/model rows", () => {
  const models = parseOpenCodeModels(
    ["deepseek/deepseek-flash", "magpie/auto/deepseek-v4.1-flash", ""].join("\n")
  );
  assert.deepEqual(models, [
    { value: "deepseek/deepseek-flash", label: "deepseek-flash", group: "deepseek" },
    { value: "magpie/auto/deepseek-v4.1-flash", label: "auto/deepseek-v4.1-flash", group: "magpie" },
  ]);
});

test("claudeModelsFromSettings reads the picker table and falls back to aliases", () => {
  assert.deepEqual(
    claudeModelsFromSettings({
      modelPicker: {
        options: [
          { model: "group/flash[1m]", label: "flash · routing group", description: "via magpie" },
          { model: "claude-sonnet-4-6", label: "Sonnet 4.6" },
        ],
      },
    }),
    [
      { value: "group/flash[1m]", label: "flash · routing group" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    ]
  );
  assert.deepEqual(claudeModelsFromSettings({}), [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
  ]);
});

test("a listing that grows is polled until two reads agree", async () => {
  // The exact shape measured from `opencode models` on a cold machine: the
  // first run starts OpenCode's background service and prints nothing, the
  // second has two providers loaded, the third has them all.
  const answers = ["", "a/one\nb/two\n", "a/one\nb/two\nc/three\n", "a/one\nb/two\nc/three\n"];
  let calls = 0;
  const settled = await pollListingUntilSettled(
    async () => answers[Math.min(calls++, answers.length - 1)]!,
    6,
    0
  );
  assert.equal(settled, "a/one\nb/two\nc/three\n");
  assert.equal(calls, 4, "it must not stop on the partial answer");
});

test("a listing that never answers is a failed read, not an empty catalog", async () => {
  let calls = 0;
  const settled = await pollListingUntilSettled(async () => {
    calls += 1;
    return "\n  \n";
  }, 3, 0);
  assert.equal(settled, undefined, "no rows at all must not read as 'this agent offers no models'");
  assert.equal(calls, 3);
});

test("a listing that is already stable costs one read", async () => {
  let calls = 0;
  const settled = await pollListingUntilSettled(
    async () => {
      calls += 1;
      return "a/one\nb/two\n";
    },
    6,
    0
  );
  assert.equal(settled, "a/one\nb/two\n");
  assert.equal(calls, 2, "one read to see the list, one to confirm it settled");
});

test("a listing that keeps growing still returns the last real answer", async () => {
  // Bounded wait: an agent whose catalog never stops growing must not hang the
  // request, and the last read is still what the CLI actually said.
  const answers = ["a/1\n", "a/1\nb/2\n", "a/1\nb/2\nc/3\n", "a/1\nb/2\nc/3\nd/4\n"];
  let calls = 0;
  const settled = await pollListingUntilSettled(
    async () => answers[Math.min(calls++, answers.length - 1)]!,
    3,
    0
  );
  assert.equal(settled, "a/1\nb/2\nc/3\n");
  assert.equal(calls, 3);
});
