# AGENTS.md

给在本仓库里干活的 agent（以及人）的工作约定。`README.md` 描述系统怎么用、有哪些能力；这里只写**怎么改这个代码库**。

## 核心规则：不为旧数据写兼容逻辑

**代码只保证「新产生的数据是正确的」。旧数据不迁移、不回填、不在读取路径上兜底。**

具体到工程上：

* **读就是读，写就是写。** 存储层只保存生成时算出来的结果。`GET` / 渲染 / 列表 / 详情一律不做重新解析、重新投影、重新清洗、格式修补。投影（比如 handoff 的 `content` 从 checkpoint 解析出来）**只发生在生成那一刻**，之后那行记录就是事实。
* **不加「兼容老格式」的分支。** 不写 `if (oldShape) { … }`、不写「为老记录重新推导一遍」的代码、不写只在历史数据上才会触发的兜底路径。
* **不加「读取时兜底」。** 一个记录如果内容不对（模型思考泄漏、格式不合法、解析不完整、字段缺失），它就是**脏数据**——不要试图在读取或渲染时抢救它。删除它，或者当它不存在，然后重新生成。
* **不做数据迁移脚本**去修历史记录，除非用户明确要求。
* **数据格式变更时直接改，不留双写/双读过渡期。** 本地存储（`dataDir` 下的 store）不是需要长期兼容的生产库。

这样做的目的是：代码里没有历史包袱，逻辑是线性的、可读、每一条路径都能一句话说清；代价是老数据不可用，这是被明确接受的取舍。

### 这条规则在 handoff 上的具体体现

* Handoff 的 `content` 在**生成时**一次性投影出来并落库：`selectHandoffContext()` 选出逐字保留的 pinned / retained 上下文，`assembleHandoffContextBundle()` 把 checkpoint 与预算账目组装成 `content.contextBundle`，`handoffCheckpointToContent()` 投影出供 UI 检查的字段；`packages/server/src/app.ts` 的 handoff 读接口原样返回记录（列表接口只返回索引行，不重算任何内容）。
* 摘要回答的清洗（`extractCheckpoint()`：丢掉思考前言、只取最后一个 `## Goal` 块）只在**生成时**执行一次（`generateHandoffSummary`），且只覆盖**没有被逐字保留**的那部分历史。渲染器 `renderHandoffBody()` 把 `contextBundle.checkpoint` 与 pinned / retained slices 原样嵌入，不重新解析。
* **验证 handoff 新效果的方式：新开一条链。** 新建 Task（或新开一条不带旧 checkpoint 的会话），显式触发一次 Handoff，看**新生成的记录**。不要拿历史 Handoff 记录判断新逻辑是否生效——历史记录脏是正常的，删掉即可。

## 提交与推送：等我审查同意，不要主动操作

**不要主动 `git commit`、也不要 `git push`。** 开发（改代码、跑测试、自验）完成后就停下来，把改了什么、验证结果、以及其中的取舍讲清楚，**等用户审查并明确同意后再提交推送**。

* 只有用户明确说了「提交」/「推送」/「commit」之类，才执行；而且只提交用户同意的那部分改动。
* 用户没同意前，不要开分支、不要建 PR、不要 checkout worktree、不要改写历史——意图相同：**别在用户看到之前把改动固化或推出去**。
* 完成开发后改动就留在工作区，等审查。不要把「自己觉得改完了」当成可以提交的信号。
* 不要提交未经用户确认的顺带改动（顺手重构、格式化、无关修复）——如实说明，由用户决定。
* 例外：用户明确要求「提交并推送」时，按用户说的做。

## 通用约定（沿用本仓库既有习惯）

* **提交信息**用英文、祈使句标题 + 解释性正文（说明「为什么」而不是「改了什么」）；一个提交一件事。
* **改行为就要改文档**：用户可见的能力/失败语义变化同步更新 `README.md`（中文），必要时更新 `docs/`。
* **失败要响**：不接受静默降级。能力不可用就报错（带 `code`），只有调用方/用户显式确认才降级，且降级必须可见（例如 `handoff.generation.method = "heuristic"`）。
* **概念不要混**：会话内的 Context Compaction 属于 harness，AgentFabric 从不做；跨会话的 Handoff 是 AgentFabric 的显式动作。两者在代码、文案、UI 里都要分开表述。

## 命令

```bash
npm run typecheck                                # 全仓库类型检查
npm run test --workspaces --if-present           # 全仓库测试（node:test）
npm run test -w @agentfabric/core                # 只跑 core
npm run build                                    # 构建全部 workspace（含 Web 产物）
npm run dev:server                               # 起服务（用户实例默认 :7377）
npm run dev:web                                  # 只重建 Web 时需要
```

Web 产物在 `packages/web/dist`，**不在 git 里**；只改 `packages/web/src` 后需要重新构建并刷新页面才能看到效果。
