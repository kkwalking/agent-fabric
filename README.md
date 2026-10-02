# AgentFabric

> **Run any agent, on any model, in any environment.**

AgentFabric 是一个开源 Agent Runtime Orchestration 平台。它不定义 Agent 应该如何思考，而是提供统一的基础设施来管理 **LLM Provider、Model、Agent Runtime、Workspace、Task、Run、RuntimeSessionRef、Runtime Native State、Artifacts 与 Observability**。

用户可自由选择模型 Provider、Model 与 Agent Runtime，通过统一协议执行 Agent Task，并在本地进程或隔离容器中运行。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Web UI (React + Vite)         CLI (af)         外部系统/API  │
└───────────────────────────────┬──────────────────────────────┘
                                │ REST + SSE (Event/Log streaming)
                        ┌───────▼────────┐
                        │  API Server    │  Express
                        └───────┬────────┘
                                │
                        ┌───────▼─────────────────────────┐
                        │  AgentFabric Core               │
                        │  Provider · Model · Runtime     │
                        │  Workspace · Task · Run         │
                        │  RuntimeSessionRef · NativeState│
                        │  Event · Artifact · Secret      │
                        │  Profile · Usage/Cost · Proxy   │
                        │  Orchestrator (Run lifecycle)   │
                        └───────┬─────────────────────────┘
                                │ Harness Adapter (RuntimeRegistry)
                                │ + Execution Backend (local / docker)
                  ┌─────────────┼──────────────┬──────────────┬─────────────┐
                  ▼             ▼              ▼              ▼             ▼
             OpenCode       Pi Agent        Codex        Claude Code       DSH
             Adapter        Adapter         Local         Local          Headless
             (本地+容器)    (本地+容器)     (本地)         (本地)          (本地)
                  │
                  └── Docker Adapter (容器) · Mock Adapter (模拟)
```

设计原则：

* **Provider → Model**：Model 不绑定具体 Provider 实现，通过统一配置获取模型信息。
* **Task + Runtime + Model + Workspace + Tools + Secrets + Policy → Run**：一次 Task 提交产生一个独立 Run。
* **Runtime-neutral**：核心系统只依赖 `AgentRuntimeAdapter` 协议，新增 Runtime 无需改动核心。
* **Containers are disposable；Workspace is durable**：容器可随意销毁重建，工作成果落在 Workspace。
* **Harness sessions stay native**：AgentFabric 只保存原生 Session 的不透明引用，不统一、不转换。

## 功能清单

| 领域 | 能力 |
| --- | --- |
| Provider | 增删改查、API 接口格式（OpenAI Responses / Completions / Anthropic / 兼容 / 自定义）、自定义 Base URL 与额外 Header、API Key 走 Secrets、启用/禁用 |
| Model | 增删改查、所属 Provider、参数、Alias、运行时自由选择 |
| Runtime | OpenCode / Pi / Codex / Claude Code / DSH / Docker / Mock，统一 Adapter 协议，可扩展 |
| Container / Sandbox | Docker 容器创建/销毁、CPU/Memory 限制、Workspace 挂载、Env/Secret 注入、网络策略、生命周期、超时 |
| Workspace | 本地目录 / Git / Volume，持久化，与 Run 关联 |
| Task | 指定 Runtime / Model / Workspace / Env / Secrets / 资源限制 / 超时 / Policy；软删除后保留 30 天可恢复，过期物理清理 |
| Run | Pending→Starting→Running→Completed/Failed/Cancelled/Timeout，查看/取消/重跑 |
| Runtime Native Session | 只保存 Harness 原生 Session 的不透明引用（RuntimeSessionRef），同 Harness 走 Native Resume，跨 Harness 走 Handoff；不存在统一的 AgentFabric Session |
| Runtime Native State | Harness 私有状态的持久化目录（Opaque），容器销毁后仍可恢复 Native Session |
| Events & Logs | 统一标准事件，REST 查询 + SSE 实时流 |
| Artifacts | 代码、Diff、Report、Test Result、Build Output、最终结果 |
| Usage & Cost | Input/Output/Cached/Reasoning Token、请求数、时长、估算成本，按 Model/Provider/日期聚合；Web UI 以日历热力图展示近 26 周活动（可按费用 / Token 切换指标） |
| Secrets | 统一管理、值不出现在日志/事件、按需注入容器 |
| Agent Profile | 复用 Runtime/Model/Policy/Env/Tools 组合（API 与 CLI 可用） |
| Execution Policy | 最大时长/模型调用/Token/Cost、CPU/Memory、网络、Shell/Tool 权限 |
| Proxy | 全局出网代理配置，注入新启动的 Harness 进程，并提供连通性测试 |
| 交互入口 | Web UI、`af` CLI、REST + SSE API |

## 快速开始

要求：Node.js ≥ 20（开发使用 24）、Docker（可选，用于容器化 Runtime）。

```bash
npm install
npm run build          # 构建全部包（含 Web UI → packages/web/dist）

# 启动 API 服务器（默认 http://localhost:7377，自动托管 Web UI）
npm start

# 开发模式：分别启动 server 与 web（web 走 vite 代理到 7377）
npm run dev:server
npm run dev:web
```

打开 http://localhost:7377 查看 Web UI。

## Web UI

侧边栏按用途分组：

* **Tasks / Dashboard** — 主要工作入口。Dashboard 汇总各资源数量、总成本，并提供 Deleted tasks 入口。
* **Resources** — `LLM`（Provider 与 Model 列表及编辑）、`Runtimes`、`Native sessions`、`Handoffs`、`Workspaces`。
* **System** — `Runs`、`Usage`、`Proxy`、`Settings`。

Agent Profiles 目前仅通过 API 与 CLI 提供，Web UI 未开放入口。

### Task Thread（`/tasks/:taskId`）

Task Thread 是主交互页面，用户消息（`run.userPrompt`，绝不是拼接后的完整 Harness Prompt）、Agent 工作过程（可读、默认折叠的 Tool / Command / File Activity）与 Agent 回答（`agent.message`）在同一页面持续展开。

* 底部 Composer 继续任务，可切换 Runtime / Model，并实时提示即将发生 **Resume**（同 Harness）还是 **Handoff**（跨 Harness，携带 Context Bundle：checkpoint + 逐字保留的工作上下文）。
* 运行中可 Stop；失败提供 Continue / Switch runtime 与 View run 调试入口。
* 普通 turn 不暴露 Run 概念——Run 是执行细节，调试 / 审计走 Runs 页与 Run Inspector。
* 对已接管的 Task，页面提供 Refresh：先重读原生会话同步新增 turn，再重读页面数据。

### Run Inspector（`/runs/:runId`）

高级执行详情 / 调试 / 审计页面：Raw Events、Logs、Artifacts、Usage、Runtime Native Session、Native State、Handoff 与完整 `inputInstruction`。

Runs 页每个产生过 native session 的 Run 在操作列提供 **copy session id**——悬停可见完整 id 与该 harness 的 resume 命令（`claude --resume <id>` / `codex exec resume <id>` / `pi --session <id>` / `opencode --session <id>`），复制后可直接去原生 harness CLI resume；Run Inspector 的 native session 行提供同样的复制按钮。

### Presentation Layer

前端把 Raw Event 经 Presentation Projector 投影为 Timeline Item（事件合并：`tool.started`+`tool.completed` → 一个 Tool Activity，`shell.command`+`shell.output` → 一个 Command Activity），不修改 Core Event Schema；`GET /api/tasks/:id/thread` 提供只读聚合，未引入新的 Message / Conversation / Session 后端模型。

## Task 与 Run

**Users interact with Tasks. The system executes Runs.** Task 是产品界面，Run 是执行细节。

一个 Task 可以跨多个 Run 持续存在：Workspace 保存工作成果，同 Harness 使用 Native Resume，不同 Harness 通过 Handoff 完成交接，Runtime Container 根据执行需要动态创建和销毁。

### 任务删除与恢复（软删除 + 30 天保留）

* **删除入口（Tasks 页）**：每条 Task 行右侧的三点菜单提供 **Delete**。删除是**软删除**——写 `deletedAt` 时间戳后从 Tasks 列表消失，但对该 Task 的一切 scoped 读写（thread 页、continue、handoff、sync-thread、按 id 读取）表现为「不存在」（404）；它的 runs、事件、handoffs 等从属数据原样保留，不发生任何改写。
* **恢复入口（Dashboard）**：Dashboard 的 **Deleted tasks** 卡片显示已删除 Task 的数量，点击进入 `/trash`（Deleted tasks 页），每条可 **restore**——清除 `deletedAt` 后 Task 连同全部历史回到 Tasks 页。
* **30 天后物理清理**：保留期 `TASK_RETENTION_MS` = 30 天。服务器启动时执行一次、之后每小时一次后台清理 pass，把 `deletedAt` 超过保留期的 Task **连同其 runs、run 事件 shard 文件、artifacts、handoffs、runtime session 引用一起物理删除**；清理失败打错误日志。
* **API**：`GET /api/tasks` 默认只返回未删除 Task，`?deleted=true` 返回已删除列表；`DELETE /api/tasks/:id` 软删除；`POST /api/tasks/:id/restore` 恢复；`GET /api/dashboard` 的 `counts.tasks` 只计未删除 Task，`counts.deletedTasks` 为已删除数量。

### Task 可用的 Runtime（usableInTask）

每个 Runtime 记录带 `usableInTask` 属性：**是否可作为 Task 的执行目标**。可用列表由后端给出——`GET /api/runtimes?usableInTask=true` 返回启用的、允许执行任务的 Runtime，New task 与 Task Thread 页面渲染这个列表（不自行派生）；服务端在 submit / continue 时做同一校验，目标 Runtime 不可用即拒绝（`code: "runtime-not-usable"`），所以前端过滤不可能被 API 绕过。接管（adopt）来的会话不受此限制、照常进入 Task（接管只投影历史、不执行模型），但继续执行时同样要过这道校验。

取值来源是 kind 级默认表，创建 Runtime 时写入，显式传入的值优先：

| kind | 默认 `usableInTask` |
| --- | --- |
| `opencode` / `pi` / `dsh` | `true` |
| `codex` / `claude-code` / `zcode` / `docker` / `mock` / `custom` | `false` |

Runtimes 页每行提供 **allow / disallow in tasks** 切换，想用某个 kind 时翻开即可。表格只保留身份与状态列，点击任意一行弹出该 Runtime 的完整属性窗口（含同样的操作按钮）。绕过 UI 直接把任务提交到不可用 Runtime 会以 `runtime-not-usable` 明确失败，而不是等到 harness 启动才炸（没有运行适配器的 kind 仍会以 `No adapter registered for runtime kind "…"` 失败）。

### 容器生命周期

| 模式 | 行为 |
| --- | --- |
| `ephemeral`（默认） | 每个 Run 新建容器，Run 结束/失败/取消/超时后销毁 |
| `keep-alive` | Run 结束后容器保留 `idleTimeoutMs`（默认 10 分钟），期间同 Runtime+Workspace 的下一个 Run 通过 `docker exec` 复用；空闲超时自动销毁（重启后由容器 label 恢复定时器，不泄漏） |
| `persistent` | 长期存活容器（Daemon 场景），容器不被销毁 |

生命周期可在 Runtime 上配置，也可按 Run 覆盖（`POST /api/runs` / `POST /api/tasks/:id/continue` 传 `lifecycle`）。`GET /api/containers/kept` 与 `af containers kept` 可查看 keep-alive 保留中的容器。

### Workspace

Workspace 是持久、Runtime-neutral 的一等资源：Task 引用（而非拥有）Workspace，容器可随意销毁重建而 Workspace 独立存在。

* **Create / Import**：新建空目录，导入已有本地目录或 Git 仓库（`git` 类型在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`）。
* **Attach**：Run 时挂载进容器。
* **Save**：Run 结束后校验并记录 `lastSavedAt` / `lastSavedRunId`。
* **Usage**：`GET /api/workspaces/:id/usage` 查看被哪些 Task/Run 引用，并记录目录 `status`（`ready` / `missing`）。

## Resume 与 Handoff

AgentFabric 只保存 Harness 原生 Session 的不透明引用（`RuntimeSessionRef`：Runtime 类型/版本、native ref、是否可 Resume、执行后端、metadata），不理解更不转换其内部结构。同 Harness 继续走 **Resume**，跨 Harness 继续走 **Handoff**。

* **Runtime Native State**：Harness 用于 Native Resume 的私有状态（Session 存储、内部数据库等）由 AgentFabric 以 Opaque 目录持久化（Create / Mount / Preserve / Reattach / Delete），与 Workspace 严格区分——Workspace 是用户的工作内容，Native State 是 Harness 的私有数据。默认落在 `~/.fabric/native-state/<runtimeId>`，按 Harness 挂载到容器内对应路径（OpenCode `/root/.local/share/opencode`，Pi `/root/.pi`，可用 `runtime.config.nativeStateMountPath` 覆盖）。
* **Resume**（同 Harness）：`continueTask` 优先用存储的 native ref 恢复 Harness 自己的 Session（本地与容器化执行语义一致）。自动 Resume 需要 **Same Harness × Same Workspace × 有效 RuntimeSessionRef × Native State 真实存在 × 当前执行方式下能力成立**；不满足时不会自动降级，需要显式 Handoff 才能开新 Session。
* **Continue 的默认目标 runtime**：显式指定 > **最近一次 run 的 runtime** > task 创建时的默认 > 第一个启用的 runtime。中途换过 Harness 的 task，不带目标的「继续」落在最近干活的 Harness 上。预览（`continue-options`）与实际决策（`pickTargetRuntime`）保持同一顺序。
* **Resume vs Handoff 预览**：`GET /api/tasks/:id/continue-options` 让用户在执行前明确看到即将发生的是 Resume 还是 Handoff，不生成内容。
* **Runtime Capability**：adapter 声明 `supportsNativeSession / supportsNativeResume / supportsStreamingEvents / supportsHandoffGeneration / supportsWorkspace / supportsInteractiveExecution`，并可通过 `containerizedCapabilities` 按执行后端收窄——声明的能力必须在当前 Execution Backend 下真实可用。容器化 Runtime 未配置可用镜像时，这些能力自动收窄为 false。`GET /api/runtimes/:id/capabilities` 返回生效的能力集合。

### Handoff ≠ Summary

Handoff 的目标不是「把旧 session 总结短一点」，而是**在目标 context budget 允许的范围内，最大限度重建上一个 Harness 的工作前沿**，让新 Harness 像接手进行中的工作一样继续。一次 Handoff 由结构化 Checkpoint（历史状态索引）、逐字 pin 的历史用户上下文、逐字保留的最近工作轨迹、Current Frontier 与 Workspace / metadata 组成；摘要只是「装不下的历史」的降级表示。

**Handoff 永远只能被显式触发**（UI 的 Handoff 按钮 / `POST /api/tasks/:id/handoff` / `mode: "handoff"`），发送消息绝不会顺手生成一个——`continueTask` 在需要 handoff 却没有现成的时候抛 `HandoffRequiredError`（`code: "handoff-required"`），由前端弹确认后再生成并发送。

### Context Bundle

生成时一次性投影并落库（`selectHandoffContext()` 选出逐字保留的 pinned / retained 上下文，`assembleHandoffContextBundle()` 组装 checkpoint 与预算账目，`handoffCheckpointToContent()` 投影出供 UI 检查的字段）。渲染正文结构：

```text
# How to read this handoff     阅读顺序 + 信任规则（先于一切不可信数据）
# Workspace                    权威工作目录（AUTHORITATIVE current state）
# Historical checkpoint        历史状态索引——明确早于 recent context
# Preserved user instructions  逐字保留的历史用户指令（[User-authored] / [User-context]）
# Recent working context       逐字保留的最近轨迹（晚于 checkpoint，冲突时 later wins）
# Current frontier             最新状态（保留轨迹末尾的确定性提炼）
# Notes from the user          handoff 时用户补充
# Your instruction             消费轮追加的最新用户指令（不属于渲染正文）
```

* **Checkpoint 由模型写**（结构化模板：Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context），但只覆盖**没有被逐字带走的那部分历史**——被 head+tail 截断过的 item 只算 partial，仍然留在 checkpoint 输入里。已有 Checkpoint 走 `<previous-summary>` 迭代更新；超长前缀按输入预算分块，每块的 Checkpoint 作为下一块的 `<previous-summary>`；read/modified 文件以 `<read-files>` / `<modified-files>` XML 累积（ephemeral 临时路径不进清单）。只取模型回答本身，`reasoning` / `reasoning_content` / `agent.thinking` 一律排除。整段历史都在总预算内逐字保留时，不调用模型、也不产生 Checkpoint。
* **时间语义**：checkpoint 描述 recent working context 发生**之前**的历史状态；正文声明 status / progress / blockers / next steps 冲突时 later context wins。
* **Current Frontier**：取保留轨迹末尾的最新 assistant 结论（`FRONTIER_MAX_CHARS` 截尾限长，按预算比例预留），确定性生成，不另调模型。
* **历史用户上下文逐字 pin**：原始任务与更早的用户指令放得下就逐字保留；超出 pin 预算时至少保留原始任务，并从最近的用户轮次倒序补齐。渲染正文声明历史 user message 按时间顺序排列，后面的用户指令在与前面冲突时覆盖前面；接收轮的最新用户指令按位置权威覆盖所有保留历史。
* **最近工作轨迹逐字保留**：选择从历史尾部向前进行（最近的用户指令 > 最近的工具调用/结果 > 最近的助手结论），预算耗尽时丢的是最老的部分。保留以**原子单位**为单位：整条 user / assistant 消息、`tool call + 匹配的 tool result`、`shell.command + 其输出`。tool call/result 配对 deterministic：有 native `toolCallId` / `callID` 时按 ID 配对，没有 ID 时按「工具名 + 目标参数」匹配到对应的 pending call。
* **来源权威（provenance）**：AgentFabric 编排层记录的裸输入 → `[User-authored]`（用户原话）；harness 回显的 user 轮次与接管的原生线程 → `[User-context]`（可能含 harness 包装，检测到 `# Files mentioned by the user` / `## My request:` 等包装时 Inspector 标注）。
* **工具交互完整性**：每个保留的 tool call 都有显式结局语义——正常结果、`[Tool result status]: completed — no textual result payload was captured`（完成无文本）、`result unavailable in the normalized source events`（源事件缺 result）、`[Tool result]: FAILED — <错误原文>`、可重建而有意省略的标记，五种状态互不混淆。
* **语义投影**：成功的本地大 mutation（`edit` / `write` / `apply_patch` 等，body 超过 `MUTATION_BODY_PROJECT_THRESHOLD_CHARS`）保留「工具 + 目标路径 + 操作语义」并注明最终文件可从 shared workspace 重建；失败的 mutation 保留目标、body 头部与完整错误。本地只读观察（`read(path=…)`、`cat src/foo.ts`、`git diff` 等）在 shared workspace 仍在时可重建，保留 tool call 与明确标记而不伪造旧内容；ephemeral 路径不算可重建。shell 命令、测试命令、查询、git 命令等高保真参数永不投影。
* **序列化边界**：所有保留 slice 的正文渲染在角色标签之后，含标题行 / `[User]:` 标记 / 多行 / 围栏的内容包在自适应长度代码围栏里，历史内容无法伪装成 Handoff 控制结构或获得用户权威。信任规则先于任何原始 tool 数据出现。
* **Workspace 是权威**：正文首段声明相对路径的解析基准，并明确 workspace 是 AUTHORITATIVE current state——历史 edit 正文只是可重放数据，读当前文件优先。
* **观测性数据不进模型上下文**：token 用量 / 成本 / 计费只留在 Run 记录与 Inspector，渲染正文绝不包含。

### 预算

* **Handoff 总预算** = `min(configuredMaxHandoffTokens, floor(targetContextWindow × handoffContextRatio))`，默认 `150_000` / `0.15`。**150K 是上限不是配额**：有价值的上下文只有 8K 就发 8K。
* **Checkpoint 预算**独立，默认 `checkpointMaxTokens = 12_000`（且不超过摘要模型窗口的一半与模型 `maxTokens`）。
* **目标窗口解析顺序**：显式 target/runtime capability（`runtime.contextWindow` / `runtime.capabilities.contextWindow` / `runtime.config.contextWindow`）> 已配置的 AgentFabric model `contextWindow` > 安全默认 `128_000`（`DEFAULT_TARGET_CONTEXT_WINDOW`）。绝不按模型名猜测、绝不联网查询；解析结果连同来源 `contextWindowSource`（`runtime-capability` / `configured-model` / `default`）记进预算账目。
* **Token 估算只有一个入口**（`estimateTextTokens` / `handoffTextCost`）：拉丁/代码/日志用 `charsPerToken = 2`，CJK 按每字符至少 1 token 计入。
* **预算账目覆盖真正渲染的每个 section**：checkpoint、frontier、pinned、retained、workspace/run metadata、渲染脚手架与 user notes 都计入 `estimatedTokens`；`userNotes` 先从总预算预留。若单是 user notes 就超过整个 handoff 预算，明确报错（`HandoffBudgetExceededError`，`code: "handoff-budget-exceeded"`）。
* Bundle 记录 `contextWindow / contextWindowSource / maxTokens / estimatedTokens / checkpointTokens / pinnedTokens / retainedTokens / frontierTokens / metadataTokens / userNotesTokens / charsPerToken`。

### Checkpoint 模型与失败语义

写 Checkpoint 的模型按显式优先级选择，并把选择依据记进 `generation.modelSource`（`configured` / `previous-run` / `first-enabled`）供审计：

1. **Handoffs 页配置的模型**（存 `config.handoff.modelId`，经 `GET/PUT /api/handoffs/model` 读写，写入时即校验模型与 provider 存在且启用）
2. **被交接 Run 自己的模型**
3. **第一个启用的模型**

配置的模型一旦失效（模型或 provider 被删/停用），生成**响亮失败**、绝不静默换一个模型：严格调用方直接报 `handoff-unavailable`，Handoffs 页的配置卡同时就地提示「配置的模型不可用」。

Checkpoint 模型不可用（未配置 provider/model、调用失败、回答不是 Checkpoint——没有 `## Goal` 标题）时，默认**报错**并携带 `code: "handoff-unavailable"`：

* 显式 Handoff 请求（`POST /api/tasks/:id/handoff`、`mode: "handoff"`）直接失败；
* 隐式跨 Harness 继续返回 409，由前端向用户说明原因后，**只有用户显式确认**才以 `allowDegradedHandoff: true` 继续。此时产出结构化摘要（任务 / 文件变更 / 工具 / 末条消息），并在 `handoff.generation.method = "heuristic"` 上标注为**降级**，UI 显著提示「非模型 Checkpoint」。

整次 handoff 生成（含分块与重试）受总预算约束（`HANDOFF_GENERATION_BUDGET_MS`，默认 10 分钟；单次调用另有 4 分钟安全上限），超预算即中止并进入上面的失败策略；调用方的 `AbortSignal` 一路透传到模型调用与重试退避——HTTP 客户端断开、或点 Handoff 生成弹层的 Cancel，都会真正停止服务端工作。Thread Adoption 属系统路径，自动带 `allowDegraded: true` 以保证接管不被阻塞。

### 可审计

* `GET /api/handoffs/:id` 返回完整记录：Context Bundle、每个 slice 的 `retention`（`pinned` / `recent` / `paired` / `oversized-truncated`）、预算账目（含目标窗口来源与各 section 实际开销）、渲染后的正文、被哪些 Run 消费。
* `GET /api/handoffs`（列表）只返回索引行（id / 来源 / generation / 覆盖的 Run），不含庞大的 context。读接口原样返回记录，不重算任何内容。
* Handoff 详情页单独展示 bundle、预算与 frontier，调试时能直接看出「某段 context 为什么被留下」「这次 handoff 用了多少预算、预算从哪来」，并可把渲染后的正文**导出为 Markdown 文件**（`handoff-<id>.md`）——导出的就是页面展示的、交给下一个 Harness 的同一份正文，纯前端下载，服务端不重新渲染。

### Handoff ≠ Context Compaction

**Context Compaction 是会话内的**——harness（pi / Claude Code）为了让活会话装进模型窗口而摘要较早的轮次，之后继续用同一个 native session；AgentFabric 从不做这件事，它属于 harness。**Handoff 是跨会话的**——当前 native session 结束，新的 session（通常换 harness）以上面的 Context Bundle 作为上下文，并落库为一条 `Handoff` 记录。两者在代码、文案、UI 里都分开表述。

## Harness

每个 Harness 是有明确执行契约的 Runtime kind。除 Docker / Mock 外，它们都是 **harness-native** 认证：使用自己账号登录与套餐额度，AgentFabric 只检测「已安装 / 已登录 / 可用」，**不读取、不复制、不保存**任何 credential，也绝不把订阅转换成 AgentFabric Provider。harness-native Runtime 不注入模型默认值，Usage / Cost 只采用 CLI 自报数字。

| Kind | 执行 | 认证 | 原生 Resume |
| --- | --- | --- | --- |
| `opencode` | 本地 + 容器 | AgentFabric Provider / Model | `opencode --session <id>` |
| `pi` | 本地 + 容器 | AgentFabric Provider / Model | `pi --session <id>` |
| `codex` | 仅本地 | harness-native（ChatGPT 登录） | `codex exec resume <id>` |
| `claude-code` | 仅本地 | harness-native（Claude.ai 登录） | `claude --resume <id>` |
| `dsh` | 仅本地 | harness-native（DeepSeek 账号） | `--session-id <id>`（受限，见下） |
| `docker` | 容器 | — | — |
| `mock` | 本地 | — | — |

OpenCode / Pi 本地适配器依赖本机已安装的 CLI（`AGENTFABRIC_OPENCODE_BIN` / `AGENTFABRIC_PI_BIN` 可覆盖）。容器化 OpenCode 默认使用官方镜像 `ghcr.io/anomalyco/opencode`；容器化 Pi 没有官方镜像，未配置镜像（`runtime.image` 或 `AGENTFABRIC_PI_IMAGE`）时**拒绝启动**并提示契约——参考镜像见 `docker/pi.Dockerfile`。镜像默认以 ENTRYPOINT 为 harness；无 entrypoint 的镜像可设 `runtime.config.containerCommand`。

### 事件映射与 Usage

Local 与 Docker 共用同一个 Harness Parser（事件 / Session Ref / Usage / 错误），Execution Backend 只做传输：容器的 stdout/stderr 以原始行流交给对应 Harness Adapter，由同一套解析器处理。

* **Pi**（`pi --print --mode json`）：`session` 头、`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end` → `run.progress` / `agent.message` / `agent.thinking` / `tool.started` / `tool.progress` / `tool.completed` / `runtime.error`。
* **OpenCode**（`opencode run --format json`）：`step_start` / `text` / `reasoning` / `tool_use` / `step_finish` / `error`（每行携带 `sessionID`）→ 同一套标准事件。
* **Codex**（`codex exec --json`）：agent_message / reasoning / command_execution / file_change / mcp_tool_call / web_search / turn usage。
* **Claude Code**（`claude -p --output-format stream-json --verbose`）：assistant text / thinking / tool_use→Bash·Edit·Write·Read… / tool_result / result usage。
* **DSH**（`dsh --profile headless --json [--session-id <id>] -- "<task>"`）：`session` → `status`（turn/step，`step_end` 携带该次模型请求的 usage）→ `text` / `thinking`（已提交的助手消息投影，重试中的尝试不会外泄）→ `tool_call` / `tool_result`（按 callId 配对）→ `final`。退出码 0 = 完成、1 = 中止/出错。

无法识别但有价值的事件保留为 raw debug 事件，不丢失。真实 Usage / Cost 从权威事件解析（Pi `message_end.message.usage`、OpenCode `step_finish` 的 `tokens`+`cost`）写入 Run Usage 并产生 `usage.updated` 事件。

Pi 新 Run 永远不用 `--no-session`：走正常 Session 模式，创建并把 Native Session 持久化到 Runtime Native State，随后任意容器销毁后都能用 `--session <id>` 真实恢复。

### Codex Local

直接使用本机已安装的 `codex` CLI。AgentFabric 只通过 `codex --version` / `codex login status` 检测可用性，未登录时 Run 快速失败并给出 `codex login` 修复指引。容器化被明确拒绝。

**本地 Thread 发现与读取**走 `codex app-server` 的 JSON-RPC（`thread/list` / `thread/read` / `thread/turns/list`），按 cwd / 最近更新过滤，包含 cli / vscode / exec 三类来源，只读地取出用户输入、Agent 回复与 Tool Activity——不解析 `~/.codex` 内部文件，也绝不触发新的模型请求。

### Claude Code Local

使用本机已安装的 `claude` CLI 非交互模式。AgentFabric 只通过 `claude --version` / `claude auth status` 检测可用性，未登录时 Run 快速失败并给出 `claude login` 修复指引。容器化被明确拒绝。

Claude Code 官方只提供 `--resume <id>`（无 list 命令），因此发现走本地 transcript（`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`）——相关解析被严格限制在 Claude Code Adapter 内（`packages/runtimes`），不泄漏进 AgentFabric Core，且防御性处理未知行类型；读取不触发任何模型请求。

### DSH Headless

DSH 官方 headless bundle（`@deepseek-ai/dsh-headless`）提供完整的无头运行契约。认证与凭据是 harness-native，可用性检测只看 `dsh --version`、headless profile 目录与 DSH 凭据文件的**存在性**，从不读取凭据内容；缺件时报错带补救命令（安装 CLI / `dsh plugin --profile headless add @deepseek-ai/dsh-headless` / 终端登录一次）。

`--session-id` 采纳 DSH 持久化的 Session，但 headless 的组成里没有 agent preset，DSH 的采纳校验因此**拒绝一切带 preset 的会话**——即 Desktop / Web surface 建的全部会话；同时也拒绝子代理/分叉会话，以及记录 cwd 与本次运行工作目录不一致的会话。这些校验全部由 DSH 自己在任务开始前强制执行，AgentFabric 原样透传其报错。所以 DSH 会话的完整图景是：Desktop/Web 会话——发现、读取、接管收历史，继续时走 Handoff 或其他 Runtime；只有 headless 自己建的会话能被 `--session-id` 原生续跑。

DSH 没有官方运行镜像，容器化执行在未配置 `image` 时拒绝启动（原生状态挂载点 `/root/.dsh`）；没有 headless 侧的系统提示词 flag，Agent Profile 的系统指令以前置块拼进任务文本交付（与 Codex 同法）。

### 系统指令交付

Agent Profile 的 `systemInstructions` 在创建 Run 时快照到 `run.systemInstructions`。没有 harness 侧系统提示词 flag 的 Runtime（Codex / DSH）把系统指令以前置块拼进任务文本交付。

## 本地会话发现与接管

Web UI 侧边栏 Resources 组的 **Native sessions**（`/sessions`）是本地 Harness 会话的发现页——Codex Threads 与 Claude Code / ZCode / Pi / DSH Sessions 用页内 Tab 切换，可选 Workspace 过滤（默认全部，按最近更新排序），每个会话带 cwd / 更新时间 / turn 数 / 模型 / 来源与认证状态（检测，不读 credential），**Continue in AgentFabric** 读取该会话并进入 Task Thread。采纳前会先问工作目录归属：复用已有 Workspace / 用给定名字新建一条 / 不关联（会话 cwd 与某 Workspace 路径相同时默认复用）；AgentFabric 不会自己凭空建 Workspace 记录。探测源挂在 Runtime kind 上：页面上没有已启用的对应 Runtime 时 Tab 提示去 Runtimes 页启用。New task 页面只负责描述新任务，底部给一行指向该页。

**临时目录约束（所有探测源通用）**：记录在临时目录下的会话——CI 步骤、一次性探针、测试夹具的产物——不是用户的工作，探测一律不列出。判定对所有 harness 用同一个谓词：cwd 等于或位于 `/tmp`、`/var/tmp`、系统临时目录（macOS 的 `/var/folders/…/T`）之下，字面与符号链接解析两种形态都算；相对路径无法定位，不判为临时。约束只作用于发现列表，不删除任何会话数据。

各探测源：

* **Codex Threads（`kind: codex`）**：走官方 `codex app-server` JSON-RPC。
* **Claude Code Sessions（`kind: claude-code`）**：读本地 transcript `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。
* **ZCode Sessions（`kind: zcode`）**：ZCode 没有列出历史会话的官方命令，发现直接读本地会话库 `~/.zcode/cli/db/db.sqlite`（SQLite，只读打开，仅触碰 `session` / `message` / `part` 三张会话表）。只列主会话（`parent_id` 为空的分支子会话是内部簿记）；消息/部件按库内 `sequence` 列重建顺序；标题用 `session.title`；`Bash` 工具调用投影为命令行活动，`Write` / `Edit` 系投影为文件活动，其余按通用工具调用投影；compaction 摘要作为 reasoning 条目保留在原位。
* **Pi Sessions（`kind: pi`）**：读 Pi 自己的 transcript（`~/.pi/agent/sessions/--<cwd>--/<时间戳>_<id>.jsonl`，可用 `AGENTFABRIC_PI_SESSIONS_DIR` 覆盖）——与 `pi --session` 恢复读的是同一批文件。首行 `{"type":"session",…}` 头是格式签名，无此头的 `.jsonl` 直接跳过；transcript 条目经 `id`/`parentId` 组成树，只读活动分支（末条目沿 parent 链走到根）；`session_info.name` 是标题（缺省回退首条用户输入），`model_change` 提供模型；`bash` 工具调用与其 `toolResult` 条目按 `toolCallId` 配对成命令行活动，compaction / branch 摘要投影为 reasoning 条目。
* **DSH Sessions（`kind: dsh`）**：读 DSH 的会话事件日志（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`，可用 `AGENTFABRIC_DSH_SESSIONS_DIR` 覆盖）下 `<encoded-cwd>/<session-id>/session[.vN].jsonl[.zstd]`。存储是全局一棵树：DSH 的所有 surface——Desktop / Web / headless——写这同一个会话库，探测天然覆盖全部来源，无需按 profile 合并。会话头记录 `agentPreset`（可被会话中的 `agent-preset/selected` 事件改写），探测按 DSH 自己的算法重建出当前 preset 作为会话的 `source` 属性带出。标题取最后一个非空 `session/title` 事件——DSH 先落一条首条提问截断的占位标题（`source.kind: "fallback"`），生成的标题随后改写它；列表读到生成标题出现为止（512KB 解压预算兜底）。`.zstd` 日志是逐次追加的拼接 zstd 帧——探测器按帧头切分、逐帧解压（fzstd），列表只解到首个 turn 的标题与输入前缀，读取只整解目标会话那一份；`delegationDepth > 0` 的子代理会话不进列表（按 id 仍可读）。事件投影：`turn/start` 分轮，`user/message` 首条是轮输入，`assistant/message` 的 reasoning / text 块投影为推理与回复，`tool/call` 与 `tool/result` 按 `callId` 配对，`compaction/summary` 作为 reasoning 条目保留，流式 chunk 与 sandbox/approval/retry 状态不进对话。

### 接管（Import / Adopt）

`POST /api/harness/:kind/threads/import`：

1. Read 原生 Thread / Session；
2. 按 cwd 关联（或就地导入）Workspace；
3. 每个原生 turn 记录为一个已完成 Run（事件由 thread 内容投影）；
4. 注册 thread 为可 Resume 的 Native Session，且该 Native Session 引用写在**每条**导入 Run 上（所有 turn 本就属于同一条原生会话，Runs 列表里每条导入 Run 都能复制 session id）；
5. （可选）预生成指向目标 Harness 的 Handoff。

不把原生 Thread 转换成统一 Session。

### 已接管会话的显式同步（Sync）

接管是一次性快照；之后用户可能继续在原 Harness 里对话。`POST /api/tasks/:id/sync-thread` 重读原生会话，把新增的 turn 用与接管相同的投影路径**追加**为 Run（并写上同一条 Native Session 引用），同时更新 Task 上的 `threadUpdatedAt`。

已入账的 turn = 接管/历次同步投影的 Run（`continuity: "new"`）+ 本任务在这条原生会话上 Resume 过的 Run（`continuity: "resume"`），因此不会把 AgentFabric 自己续跑的 turn 重复导入。同步会**解除**在此之前武装（`awaitingNextTurn`）的 Handoff——它基于过期快照生成，下一轮不该悄悄消费（`disarmedHandoffIds` 可见）。

触发只有两个入口：该 REST 接口，以及 Task 页面的 Refresh 按钮（对已接管 Task 先同步再重读）；**没有后台轮询，也没有「有 N 个新 turn」之类的提示**。任务有进行中的 Run 时同步直接报错；非接管 Task 调用同步同样报错。

### 探测与运行的边界

五类探测源都做**发现 + 读取 + 接管**。Pi 会话接管后可以用既有 Pi 适配器原生 Resume；**只有 ZCode 是探测器、没有运行适配器**——ZCode Runtime 默认 `usableInTask: false`，接管会话会把历史收进 AgentFabric Task，composer 里继续时选的是其他可用 Runtime（跨 harness 走 Handoff）。解析严格限定在 `packages/runtimes` 的适配器层，不进入 Core；防御性处理损坏行（DSH 列表跳过解压失败的日志，读取同一份则明确报错）；读取不会执行任何模型请求。

### 额度耗尽 UX

识别 Harness 的配额错误（如 Codex 的 "You've hit your usage limit…"），Run 上打 `errorKind: "usage-limit"`，Task 页面显示 **Codex usage limit reached.** / **Claude Code usage limit reached.** 与 **Continue with Pi / Continue with OpenCode**，一键预选目标 Harness 并立即生成 Handoff，新 Harness 建立自己的新 Native Session 继续任务。

## 执行策略（Execution Policy）

Execution Policy 在 Run 中强制执行：

* `maxDurationMs` 超时、`maxModelCalls` / `maxTokens` / `maxCost` 超限即中止 Run（failed）；
* `cpu` / `memory` 传给容器；
* `network.enabled=false` 时容器 `--network none`；
* `shell` / `toolPermissions` 与 `autoApprove`（如 OpenCode `--auto`）传递给 Harness Adapter。

默认 Run 超时 `DEFAULT_RUN_TIMEOUT_MS` = 30 分钟。Policy 可在 Agent Profile、Task、Run 各层给出，Run 级覆盖 Task 级。

## Proxy

全局出网代理（Web UI 的 Proxy 页 / `config.proxy`）。默认关闭；打开后每个**新启动**的 Harness 进程收到标准代理环境变量，正在运行的进程与 AgentFabric 服务器本身不受影响。支持 `http` / `socks5`，容器化执行时 loopback 代理地址会改写到宿主机。Proxy 页提供连通性测试（`POST /api/proxy/test`）。

## 数据与安全

* 数据保存在 `~/.fabric/db.json`（可用 `AGENTFABRIC_DATA_DIR` 覆盖到任意目录），原子写入。
* Run 事件不进 db.json：事件负载按 run 分片，append-only 追加到 `~/.fabric/events/<runId>.jsonl`；db.json 只保留每 run 一行的索引（`eventShards`：文件、条数、字节数、`lastSeq` 高水位，`lastSeq` 同时用于重启后恢复全局 seq 计数器）。读取按需从分片文件载入。
* `git` 类型 Workspace 在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`，Run 时挂载真实目录。
* Secrets 值仅在创建时返回一次，其余接口返回掩码；Secrets 不进入日志与事件；按 `secretIds` 注入 Runtime 环境变量。
* API Key 通过 `Provider.apiKeySecretId` 引用 Secret，Provider 记录中只有掩码。
* 存储层只保存生成时算出来的结果，读路径不重新解析、不重新投影、不做格式修补。

## CLI

```bash
# 数据目录默认 ~/.fabric，可用 AGENTFABRIC_DATA_DIR 覆盖；API 地址默认 http://localhost:7377
# （可用 AGENTFABRIC_API 或全局 --api <url> 覆盖，--json 输出原始 JSON）

# Provider / Model
af providers list | add | update | remove
af providers add my-openai --type openai-completions --base-url https://api.openai.com/v1 --api-key sk-xxx
af models list | add | remove
af models add gpt-4o --provider <provider-id> --alias gpt-4o

# Runtime
af runtimes list | add | update | remove
af runtimes add "OpenCode" --kind opencode
af runtimes add "Pi Agent" --kind pi
af runtimes add "My Docker" --kind docker --image node:22-alpine --command "sh -c echo hi"

# Workspace / Agent Profile / Secrets
af workspaces add repo --path /path/to/code
af workspaces import legacy --path /existing/project    # 导入已有目录
af workspaces save <ws-id> --run <run-id>
af workspaces usage <ws-id>
af agents add "Senior Engineer" --runtime <rt> --model <model> --system-prompt "You are a senior engineer"
af secrets add my-key --value sk-xxx --scope env

# 提交任务
af run "分析当前代码库并修复所有 failing tests" --from-repo --follow
af run "给 README 补充用法" --runtime <rt> --model <model> --workspace <ws> --timeout 600000
af run "..." --lifecycle keep-alive --idle-timeout 600000
af run "..." --no-wait

# 长期任务 / Handoff / 原生 Session
af tasks list | show <id> | options <id>
af tasks continue <task-id> "继续修剩下的两个测试" --mode auto --notes "不要修改现有 API"
af tasks continue <task-id> "switch harness" --runtime <other-rt>   # 跨 Harness → Handoff
af handoffs list [--task <id>] | show <id> | notes <id> "补充约束"
af runtime-sessions [--task <id>]
af native-states list [--runtime <rt-id>] | remove <state-id>
af containers kept

# Runs / Artifacts / Usage / Config
af runs list | show <run-id> --follow | logs <run-id> | cancel <run-id>
af artifacts list --run <run-id>
af artifacts get <artifact-id> --output report.md
af usage
af config [key] [value]
```

## Runtime 扩展

实现 `AgentRuntimeAdapter`（`packages/core/src/runtime.ts`）并注册进 `RuntimeRegistry` 即可接入新 Runtime：

```ts
import { AgentRuntimeAdapter, RuntimeRegistry } from "@agentfabric/core";

const myAdapter: AgentRuntimeAdapter = {
  kind: "custom",
  name: "My Agent",
  async run(ctx) {
    await ctx.log("started");
    await ctx.emit("agent.message", { content: "hello" });
    await ctx.addArtifact({ name: "result.md", kind: "report", content: "..." });
    ctx.recordUsage({ inputTokens: 10, outputTokens: 5, modelRequests: 1 });
    return { exitCode: 0 };
  },
  async cleanup(ctx) { /* 清理容器/进程 */ },
};

const registry = buildRegistry(); // 或 new RuntimeRegistry()
registry.register(myAdapter);
```

新增会话探测源则实现 `HarnessThreadSource`（`packages/core/src/harnessThreads.ts`）并注册到 server，同时在 `packages/web/src/harness.ts` 的 `HARNESS_THREAD_SOURCES` 里加上 tab 元信息。

## 目录结构

```
packages/
  core/      领域模型、JSON 持久化、EventBus、CRUD 服务、Run Orchestrator、
             Runtime 协议、Handoff 组装与渲染、Policy、Proxy、生命周期
  runtimes/  Runtime Adapters：mock / opencode / pi / codex / claude-code /
             dsh / docker，以及各 Harness 的本地会话探测与 Execution Backend
  server/    Express REST API + SSE + 静态 Web UI 托管
  cli/       af 命令行（对接 REST API）
  web/       React + Vite Web UI
docker/      pi.Dockerfile（容器化 Pi 的参考镜像）
specs/       各阶段设计文档（历史归档，实现以代码为准）
```

## 已知边界

* 成本为内置价格表的估算值；harness-native Runtime 只采用 CLI 自报成本，绝不按 API 定价估算套餐 Run 成本。
* 持久化使用 JSON 文件，面向单机部署。
* Codex / Claude Code / DSH 仅支持本地执行，容器化被明确拒绝。
* ZCode 只有本地会话探测（读 `~/.zcode/cli/db/db.sqlite`），没有运行适配器——接管后继续执行会明确报错，跨 Harness 用 Handoff。
* DSH 没有官方容器镜像，容器化执行需自备镜像。
* Network `allowedHosts` / `blockedHosts` 与 Filesystem `allowedPaths` / `deniedPaths` 未做细粒度强制（仅支持整体开关与只读挂载）。
* Agent Profiles 的 Web UI 入口未开放（API 与 CLI 可用）。
* Workspace 的 Snapshot / Fork / Diff / Lock 等高级能力未提供。

## 测试

```bash
npm run typecheck                                # 全仓库类型检查
npm test                                         # 全仓库测试（node:test）
npm run test -w @agentfabric/core                # 只跑 core
npm run build                                    # 构建全部 workspace（含 Web 产物）
```

core 测试覆盖 store / secret / mock run / cost / event bus / policy / git workspace，容器生命周期策略与 keep-alive 租约，同 Harness Native Resume 与跨 Harness Handoff，Handoff 上下文选择、预算账目与渲染语义，能力声明与随执行后端收窄。

真实 Harness 集成测试（Pi/OpenCode × Local/Docker + 跨 Harness Handoff）默认 skip，使用真实 CLI、真实模型调用与真实容器：

```bash
AGENTFABRIC_REAL_INTEGRATION=1 npm test -w @agentfabric/core
# 可选：AGENTFABRIC_PI_IMAGE=<镜像>（否则自动从 docker/pi.Dockerfile 构建）
#       AGENTFABRIC_REAL_DEEPSEEK_KEY / DEEPSEEK_API_KEY（Pi 模型调用）
#       AGENTFABRIC_OPENCODE_AUTH_JSON（OpenCode 容器认证，缺省复用本机 auth.json）
```
