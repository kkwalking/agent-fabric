# AgentFabric

> **Run any agent, on any model, in any environment.**

AgentFabric 是一个开源 Agent Runtime Orchestration 平台。它不定义 Agent 应该如何思考，而是提供统一的基础设施来管理 **LLM Provider、Model、Agent Runtime、Workspace、Task、Run、RuntimeSessionRef、Runtime Native State、Artifacts 与 Observability**。

用户可自由选择模型 Provider、Model 与 Agent Runtime，并通过隔离的容器环境执行 Agent Task。

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
                        │  Profile · Usage/Cost           │
                        │  Orchestrator (Run lifecycle)   │
                        └───────┬─────────────────────────┘
                                │ Harness Adapter (RuntimeRegistry)
                                │ + Execution Backend (local / docker)
                  ┌─────────────┼──────────────┬──────────────┐
                  ▼             ▼              ▼              ▼
             OpenCode       Pi Agent        Docker        Mock
             Adapter        Adapter         Adapter        Adapter
             (本地+容器)    (本地+容器)     (容器)         (模拟)
```

设计原则（来自 `mvp-spec.md`）：

* **Provider → Model**：Model 不绑定具体 Provider 实现，通过统一配置获取模型信息。
* **Task + Runtime + Model + Workspace + Tools + Secrets + Policy → Run**：一次 Task 提交产生一个独立 Run。
* **Runtime-neutral**：核心系统只依赖 `AgentRuntimeAdapter` 协议，新增 Runtime 无需改动核心。

## 功能清单（MVP）

| 领域 | 能力 |
| --- | --- |
| Provider | 增删改查、自定义 Base URL、API Key 走 Secrets、OpenAI-compatible、启用/禁用 |
| Model | 增删改查、所属 Provider、参数、Alias、运行时自由选择 |
| Runtime | OpenCode / Pi Agent / Docker / Mock，统一 Adapter 协议，可扩展 |
| Container / Sandbox | Docker 容器创建/销毁、CPU/Memory 限制、Workspace 挂载、Env/Secret 注入、网络策略、生命周期、超时 |
| Workspace | 本地目录 / Git / Volume，持久化，与 Run 关联 |
| Task | 指定 Runtime / Model / Workspace / Env / Secrets / 资源限制 / 超时 / Policy |
| Run | Pending→Starting→Running→Completed/Failed/Cancelled/Timeout，查看/取消/重跑 |
| Runtime Native Session | 只保存 Harness 原生 Session 的不透明引用（RuntimeSessionRef），同 Harness Native Resume，跨 Harness 走 Handoff；不存在统一的 AgentFabric Session |
| Runtime Native State | Harness 私有状态的持久化目录（Opaque），容器销毁后仍可恢复 Native Session |
| Events & Logs | 统一标准事件，REST 查询 + SSE 实时流 |
| Artifacts | 代码、Diff、Report、Test Result、Build Output、最终结果 |
| Usage & Cost | Input/Output/Cached Token、请求数、时长、估算成本，按 Model/Provider/日期聚合 |
| Secrets | 统一管理、值不出现在日志/事件、按需注入容器 |
| Agent Profile | 复用 Runtime/Model/Policy/Env/Tools 组合 |
| Execution Policy | 最大时长/模型调用/Token/Cost、CPU/Memory、网络、Shell/Tool 权限 |
| CLI / API / Web UI | 见下文 |

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

打开 http://localhost:7377 查看 Web UI（New task / Tasks / Dashboard / Task Thread 对话式执行线程 / Run Inspector / Providers / Models / Runtimes / Agents / Workspaces / Handoffs / Artifacts / Usage / Settings）。

## Web 交互模型（v5）

> **Users interact with Tasks. The system executes Runs.**
> **Task is the product surface. Run is the execution detail.**

* **Task Thread（`/tasks/:taskId`）是主交互页面**：像 Codex / Claude Code 一样，用户消息（`run.userPrompt`，绝不是拼接后的完整 Harness Prompt）、Agent 工作过程（可读、默认折叠的 Tool / Command / File Activity）与 Agent 回答（`agent.message`）在同一页面持续展开；底部 Composer 继续任务，可切换 Runtime / Model / Agent Profile，并实时提示即将发生 **Resume**（同 Harness）还是 **Handoff**（跨 Harness，带语义化交接摘要）。运行中可 Stop，失败提供 Retry / Continue / Switch runtime。
* **Run Detail 退回为 Run Inspector（`/runs/:runId`）**：高级执行详情 / 调试 / 审计页面——Raw Events、Logs、Artifacts、Usage、Runtime Native Session、Native State、Handoff 与完整 `inputInstruction`。
* **前端 Presentation Layer**：Raw Event → Presentation Projector → Timeline Item（事件合并：`tool.started`+`tool.completed` → 一个 Tool Activity，`shell.command`+`shell.output` → 一个 Command Activity），不修改 Core Event Schema；`GET /api/tasks/:id/thread` 提供只读聚合，未引入新的 Message / Conversation / Session 后端模型。

## 长期任务执行模型（v1）

在 MVP 之上，v1（`v1.md`）建立了更稳定的长期任务执行模型：

> **Task 可以跨多个 Run 持续存在，Workspace 保存工作成果，同 Harness 使用 Native Resume，不同 Harness 通过 Handoff 完成交接，而 Runtime Container 根据执行需要动态创建和销毁。**

核心抽象：`Provider · Model · Runtime · Task · Run · Workspace · Handoff · Artifact`。
设计原则：Containers are disposable；Workspace is durable；Harness sessions stay native；**Same Harness → Resume，Different Harness → Handoff**；Workspace + Handoff 提供跨 Runtime 连续性；AgentFabric 只编排执行，不统一 Agent 认知。

### Runtime Container 生命周期

| 模式 | 行为 |
| --- | --- |
| `ephemeral`（默认） | 每个 Run 新建容器，Run 结束/失败/取消/超时后销毁 |
| `keep-alive` | Run 结束后容器保留 `idleTimeoutMs`（默认 10 分钟），期间同 Runtime+Workspace 的下一个 Run 通过 `docker exec` 复用；空闲超时自动销毁（重启后由容器 label 恢复定时器，不泄漏） |
| `persistent` | 模型上预留（长期 Agent / Daemon 场景），容器不被销毁 |

生命周期可在 Runtime 上配置，也可按 Run 覆盖（`POST /api/runs` / `POST /api/tasks/:id/continue` 传 `lifecycle`）。

### Workspace

Workspace 是持久、Runtime-neutral 的一等资源：Task 引用（而非拥有）Workspace，容器可随意销毁重建而 Workspace 独立存在。基础能力：**Create / Import**（导入已有本地目录或 Git 仓库）/ **Attach**（Run 时挂载）/ **Save**（Run 结束后校验并记录 `lastSavedAt`）。Snapshot / Fork / Diff / Lock 等高级能力按规划留待后续版本。

### Resume 与 Handoff

* **Runtime Session Reference**：AgentFabric 只保存 Harness 原生 Session 的不透明引用（Runtime 类型/版本、native ref、是否可 Resume、执行后端、metadata），不理解更不转换其内部结构。
* **Runtime Native State**：Harness 用于 Native Resume 的私有状态（Session 存储、内部数据库等）由 AgentFabric 以 Opaque 目录持久化（Create / Mount / Preserve / Reattach / Delete），与 Workspace 严格区分——Workspace 是用户的工作内容，Native State 是 Harness 的私有数据。
* **Resume**（同 Harness）：`continueTask` 优先用存储的 native ref 恢复 Harness 自己的 Session（本地与容器化执行语义一致）。
* **Handoff**（跨 Harness 或无法 Resume）：生成语义化的工作交接（不迁移 Session，新 Harness 创建全新 Native Session），并以渲染后的 Handoff + 用户补充说明作为新 Run 的输入指令。
* **Handoff 来源**：Harness 自产（adapter 声明 `supportsHandoffGeneration` 并在结果中返回内容）/ **AgentFabric 辅助生成 —— 对齐 pi coding agent 的 Context Compaction 实现**（`core/compaction.ts`：把上一个 Run 的事件序列化为 pi 风格对话记录，用 pi 原版的 Summarization System Prompt 与结构化 Checkpoint 模板（Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context）调用任务模型生成摘要；任务链上前一份 Handoff 的摘要作为 `<previous-summary>` 进入 pi 的迭代更新流程；从工具调用与文件变化追踪 read/modified 文件并以 `<read-files>` / `<modified-files>` XML 追加；沿用 pi 的 0.8 × reserveTokens 摘要预算与 error/length 失败检查，失败时回退到旧的启发式提取）/ 用户补充说明（`userNotes`）。带 Checkpoint 的 Handoff（`content.compactionSummary`）在渲染进新 Run 输入指令时逐字嵌入。所有 Handoff 记录 from/to Runtime、来源 Run、Workspace 与 Artifacts，可查询可追踪。
* **Runtime Capability**：adapter 声明 `supportsNativeSession / supportsNativeResume / supportsStreamingEvents / supportsHandoffGeneration / supportsWorkspace / supportsInteractiveExecution`，并可通过 `containerizedCapabilities` 按执行后端收窄——声明的能力必须在当前 Execution Backend 下真实可用；AgentFabric 据此决定 Resume 或 Handoff，`GET /api/tasks/:id/continue-options` 让用户在执行前明确看到即将发生的是 Resume 还是 Handoff。


## 容器化 Native Resume（v2）

v2（`v2.md`）移除了旧的统一 AgentFabric Session 抽象，并打通了 Containerized Runtime 下的 Native Resume 闭环：

> **Task → Run → Runtime → RuntimeSessionRef**，其中 `RuntimeSessionRef` 是 Harness 原生 Session 的不透明引用，而不是一个新的 AgentFabric Session。

* **统一 Session 模型已删除**：顶层 `Session` 实体、`Task.sessionId`、Session 生命周期与 Session Usage 聚合、`/api/sessions*` 接口与 `af sessions` 命令均已移除；旧数据在 Store 加载时自动迁移清理。原生 Session 状态通过 Task/Run/Runtime 详情与 `/api/runtime-sessions` 了解。
* **执行后端（Execution Backend）**：`Harness Adapter → Execution Backend → (本地进程 | Docker 容器)`。Docker 只是执行载体，不再把 OpenCode/Pi 的结构化输出降级成 Shell Log——容器的 stdout/stderr 以原始行流交给对应 Harness Adapter，本地与容器化复用同一套输出解析器（事件解析、Native Session 提取、Usage/错误解析）。
* **Ephemeral Container 下的闭环**：Run #1 创建临时容器 → 挂载 Workspace + Native State → 捕获 Native Session Ref → 容器销毁；Run #2 新建容器 → 挂载同一 Workspace 与同一 Native State → 用 Native Session Ref Resume。Native State 是 Host 上的 Opaque 目录（默认 `data/native-state/<runtimeId>`），按 Harness 挂载到容器内对应路径（OpenCode `/root/.local/share/opencode`，Pi `/root/.pi`，可用 `runtime.config.nativeStateMountPath` 覆盖）。
* **Handoff 行为不变**：Pi → OpenCode 等跨 Harness 场景仍然保存 Workspace、生成 Handoff、创建全新 Native Session，不做任何 Session 转换。

## 真实 Harness 协议适配与 Resume 正确性（v3）

v3（`v3.md`）在不新增核心抽象的前提下，让现有抽象**真正正确地适配真实 Pi / OpenCode CLI**：

* **Pi 新 Run 永远不用 `--no-session`**：新 Run 走正常 Session 模式，创建并把 Native Session 持久化到 Runtime Native State（`~/.pi`，容器内挂载 `/root/.pi`），随后任意容器销毁后都能用 `--session <id>` 真实恢复。
* **Event Mapping 按真实协议重做**：
  * Pi（`pi --print --mode json`）：`session` 头、`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end` → `run.progress` / `agent.message` / `agent.thinking` / `tool.started` / `tool.progress` / `tool.completed` / `runtime.error`；无法识别但有价值的事件保留为 raw debug 事件，不丢失。
  * OpenCode（`opencode run --format json`）：`step_start` / `text` / `reasoning` / `tool_use` / `step_finish` / `error`（每行携带 `sessionID`）→ 同一套 AgentFabric 标准事件；不再假设 OpenCode 输出 AgentFabric 风格事件名。
  * Local 与 Docker 共用同一个 Harness Parser（事件 / Session Ref / Usage / 错误），Execution Backend 只做传输。
* **真实 Usage / Cost 进入 Run Usage**：Harness Adapter 从权威事件（Pi `message_end.message.usage`、OpenCode `step_finish` 的 `tokens`+`cost`）解析 Input/Output/Reasoning/Cache tokens 与真实成本，写入 Run Usage（`reasoningTokens` 新增），并产生 `usage.updated` 事件；不再把 Usage 只当普通事件。
* **容器镜像策略（Harness Execution Contract）**：见 `docs/harness-image-contract.md`。容器化 OpenCode 默认使用当前官方维护镜像 `ghcr.io/anomalyco/opencode`；容器化 Pi 没有官方镜像，未配置镜像（`runtime.image` 或 `AGENTFABRIC_PI_IMAGE`）时**拒绝启动**并提示契约，绝不静默回退到不含 Pi CLI 的普通 Node 镜像——参考镜像见 `docker/pi.Dockerfile`。
* **Native Resume 条件收紧**：自动 Resume 需要 **Same Harness × Same Workspace × 有效 RuntimeSessionRef × Native State 真实存在（目录在磁盘上）× 当前执行方式下能力成立**。不同 Workspace 不复用旧 Native Session（走 Handoff / 新 Session）；本地与容器化会话不互串。判定集中在一个可扩展的 Resume Gate，为未来（Runtime/Harness/Native State 版本、模型等维度）预留空间。
* **Capability = Harness × Backend × Runtime Config**：容器化 Runtime 未配置可用镜像时，`supportsNativeSession/Resume/StreamingEvents` 自动收窄为 false——声明的能力必须在当前实际执行方式下成立。
* **Run 级 Policy 生效**：continuation 传入的 `policy`（如 `autoApprove` → OpenCode `--auto`）现在真正传递给 Harness Adapter。

### 测试（v3）

```bash
npm test          # 在 v1/v2 基础上：
                  # + v3 单元/集成：真实协议事件映射、Usage 解析、Pi 持久化会话与 Resume、
                  #   Native State 丢失时 Resume 真实失败（fake 不再假装成功）、
                  #   Workspace/跨后端 Resume 兼容、镜像策略、Local 与 Docker 同 Parser
                  # + v3.real：真实 Harness 集成测试（默认 skip）
```

真实 Harness 集成测试（Pi/OpenCode × Local/Docker + 跨 Harness Handoff）使用真实 CLI、真实模型调用与真实容器，验证"Run #1 建会话/落盘/销毁容器 → Run #2 新容器挂载同一 Workspace + Native State → Resume 明确延续上一轮上下文"：

```bash
AGENTFABRIC_REAL_INTEGRATION=1 npm test -w @agentfabric/core
# 可选：AGENTFABRIC_PI_IMAGE=<镜像>（否则自动从 docker/pi.Dockerfile 构建）
#       AGENTFABRIC_REAL_DEEPSEEK_KEY / DEEPSEEK_API_KEY（Pi 模型调用）
#       AGENTFABRIC_OPENCODE_AUTH_JSON（OpenCode 容器认证，缺省复用本机 auth.json）
```


### API 新增（v2）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/native-states?runtimeId=` `/api/native-states/:id` | Runtime Native State 查询 |
| DELETE | `/api/native-states/:id` | 删除 Native State（目录 + 记录） |

> `/api/sessions` 系列接口已移除；Resume 通过 `POST /api/tasks/:id/continue` 完成。

### CLI

```bash
# 长期任务
af tasks list | show <id> | options <id>
af tasks continue <task-id> "继续修剩下的两个测试" --mode auto --notes "不要修改现有 API"
af tasks continue <task-id> "switch harness" --runtime <other-rt>   # 跨 Harness → Handoff

# Handoff / 原生 Session 引用
af handoffs list [--task <id>]
af handoffs show <id>
af handoffs notes <id> "补充约束"
af runtime-sessions [--task <id>]
af native-states list [--runtime <rt-id>]
af native-states remove <state-id>

# Workspace
af workspaces add repo --path /path/to/code
af workspaces import legacy --path /existing/project     # 导入已有目录
af workspaces save <ws-id> --run <run-id>
af workspaces usage <ws-id>

# 容器生命周期
af run "..." --lifecycle keep-alive --idle-timeout 600000
af containers kept
```

### API 新增（v1）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/tasks/:id` `/api/tasks/:id/runs` | Task 详情 / Run 链 |
| GET | `/api/tasks/:id/continue-options` | Resume vs Handoff 决策预览（含 Handoff 内容预览） |
| POST | `/api/tasks/:id/continue` | 继续任务（自动/强制 Resume 或 Handoff） |
| GET | `/api/handoffs?taskId=&runId=` `/api/handoffs/:id` | Handoff 查询 |
| POST | `/api/handoffs/:id/notes` | 追加用户说明 |
| GET | `/api/runtime-sessions` `/api/runtime-sessions/:id` | 原生 Session 引用 |
| POST | `/api/runtime-sessions/:id/expire` | 标记引用失效 |
| GET/DELETE | `/api/native-states` `/api/native-states/:id` | Runtime Native State（v2） |
| POST | `/api/workspaces/import` `/api/workspaces/:id/save` | Workspace 导入 / 保存 |
| GET | `/api/workspaces/:id/usage` | Workspace 被哪些 Task/Run 引用 |
| GET | `/api/runtimes/:id/capabilities` | 生效的 Harness 能力 |
| GET | `/api/containers/kept` | keep-alive 保留中的容器 |

### CLI

```bash
# 数据目录默认 ./data，可用 AGENTFABRIC_DATA_DIR 覆盖；API 地址默认 http://localhost:7377

# Provider / Model
af providers list
af providers add my-openai --type openai --base-url https://api.openai.com/v1 --api-key sk-xxx
af models add gpt-4o --provider <provider-id> --alias gpt-4o

# Runtime
af runtimes list
af runtimes add "OpenCode" --kind opencode
af runtimes add "Pi Agent" --kind pi
af runtimes add "My Docker" --kind docker --image node:22-alpine --command "sh -c echo hi"

# Workspace / Agent Profile
af workspaces add repo --path /path/to/code
af agents add "Senior Engineer" --runtime <rt> --model <model> --system-prompt "You are a senior engineer"

# 从当前代码仓库直接启动 Coding Agent Task（MVP 重点体验）
af run "分析当前代码库并修复所有 failing tests" --from-repo --follow

# 指定 Runtime / Model / Workspace / 超时
af run "给 README 补充用法" --runtime <rt> --model <model> --workspace <ws> --timeout 600000
af run "继续上次讨论" --runtime <rt> --follow

# Runs / Artifacts / Usage
af runs list
af runs show <run-id> --follow
af runs logs <run-id>
af runs cancel <run-id>
af runs rerun <run-id>
af artifacts list --run <run-id>
af artifacts get <artifact-id> --output report.md
af usage  # 或 af config / af secrets / af tasks
```

## API 概览

所有资源均为 REST JSON，实时事件用 SSE：

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dashboard` | 统计 + 最近 Runs + Usage |
| CRUD | `/api/providers` `/api/models` `/api/runtimes` `/api/workspaces` `/api/secrets` `/api/agents` | 各资源管理 |
| POST | `/api/runtimes/:id/enable` `/disable` | 启用/禁用 |
| GET/POST | `/api/tasks` | Task |
| POST | `/api/runs` | 提交 Task 并创建 Run（异步执行） |
| GET | `/api/runs` `/api/runs/:id` | 查询 Run |
| POST | `/api/runs/:id/cancel` `/rerun` | 取消 / 重跑 |
| GET | `/api/runs/:id/events` `/logs` | 事件 / 日志 |
| GET | `/api/runs/:id/events/stream` | **SSE**：单 Run 实时事件流 |
| GET | `/api/events/stream` | **SSE**：全局事件流 |
| GET | `/api/runtime-sessions` `/api/native-states` | 原生 Session 引用 / Native State |
| GET | `/api/artifacts` `/api/artifacts/:id/content` | Artifacts |
| GET | `/api/usage` | Usage & Cost 聚合 |
| GET/PUT | `/api/config` | 配置 |

示例：

```bash
# 提交一个 Task（Mock Runtime 无需任何 API Key，适合体验完整链路）
curl -X POST localhost:7377/api/runs \
  -H 'Content-Type: application/json' \
  -d '{"title":"demo","prompt":"分析代码库","runtimeId":"<mock-rt-id>"}'

# 实时查看事件
curl -N localhost:7377/api/runs/<run-id>/events/stream
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

## 目录结构

```
packages/
  core/      领域模型、JSON 持久化、EventBus、CRUD 服务、Run Orchestrator、Runtime 协议
  runtimes/  Runtime Adapters：mock / opencode / pi / docker（含容器化 helper）
  server/    Express REST API + SSE + 静态 Web UI 托管
  cli/       af 命令行（对接 REST API）
  web/       React + Vite Web UI
```

## 数据与安全

* 数据保存在 `AGENTFABRIC_DATA_DIR`（默认 `./data/db.json`），原子写入。
* `git` 类型 Workspace 在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`，Run 时挂载真实目录。
* Secrets 值仅在创建时返回一次，其余接口返回掩码；Secrets 不进入日志与事件；按 `secretIds` 注入 Runtime 环境变量。
* API Key 通过 `Provider.apiKeySecretId` 引用 Secret，Provider 记录中只有掩码。
* Execution Policy 会在 Run 中强制执行：`maxDurationMs` 超时、`maxModelCalls` / `maxTokens` / `maxCost` 超限即中止 Run（failed）；`cpu` / `memory` 传给容器；`network.enabled=false` 时容器 `--network none`。

## 已知边界（MVP）

* 成本为内置价格表的估算值，可通过未来定价 API 覆盖。
* 持久化使用 JSON 文件，适合单机 MVP；生产可替换为数据库。
* OpenCode / Pi 本地适配器依赖本机已安装的 CLI（`AGENTFABRIC_OPENCODE_BIN` / `AGENTFABRIC_PI_BIN` 可覆盖）。
* 容器化 OpenCode 默认使用官方镜像 `ghcr.io/anomalyco/opencode`；容器化 Pi 无官方镜像，必须配置满足 Harness Execution Contract 的镜像（`runtime.image` / `AGENTFABRIC_PI_IMAGE`，参考 `docker/pi.Dockerfile`），否则拒绝启动。镜像默认以 ENTRYPOINT 为 harness；无 entrypoint 的镜像可设 `runtime.config.containerCommand`。
* Network `allowedHosts/blockedHosts` 与 Filesystem `allowedPaths/deniedPaths` 暂未做细粒度强制（仅支持整体开关与只读挂载）。

## 测试

```bash
npm test          # core 单元测试：store/secret/mock run/cost/event bus/policy/git workspace
                  # + v1：生命周期策略、keep-alive 租约（超时销毁/复用/重启恢复）、workspace 导入与保存、
                  #        同 Harness Native Resume、跨 Harness Handoff、Handoff 生成与渲染、能力声明
                  # + v2：统一 Session 数据迁移清理、Native State 服务、能力随执行后端收窄、
                  #        容器化 OpenCode/Pi 跨临时容器 Native Resume 闭环（fake docker shim）、Handoff 行为不变
```
