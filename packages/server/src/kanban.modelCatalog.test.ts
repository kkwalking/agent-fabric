import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeModelsFromSettings,
  flattenModelOptions,
  parseOpenCodeModels,
  parsePiModels,
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
