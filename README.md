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
                        │  Project · Source · Credential  │
                        │  Workspace · Task · Run         │
                        │  RuntimeSessionRef · NativeState│
                        │  Event · Artifact · Secret      │
                        │  Profile · Usage/Cost · Proxy   │
                        │  Orchestrator (Run lifecycle)   │
                        │  Supervisor (Task lifecycle)    │
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
* **Project defines the codebase. Task defines the intent. Workspace holds the work. Run executes the agent. Runtime is disposable. Supervisor owns the execution lifecycle.**（Project-based Coding Task，见下）
* **Agent 负责开发，Platform 负责 publish**：commit 策略、working branch 所有权、push 与 Git credential 都是平台能力，不依赖 prompt 提醒 Agent 执行。
* **Agent Runtime ≠ AgentFabric Host**：Project Coding Task 的 Agent 与 Validation 都运行在隔离 Runtime 中，仓库内容（即不可信代码）从不在宿主上执行。
* **Git Credential ≠ Agent Secret**：`scope = git` 的 Secret 只能被 Credential Broker 使用，永不进入 Agent / Validation / MCP 的信任域。
* **Retry Publish ≠ Re-finalize Task**：Finalization 成功即冻结 `finalCommitSha`，Retry Publish 只重推这个 revision。
* **Agent Completed ≠ Task Fully Completed**：每个阶段独立记录结果，已完成的阶段不会被后续失败倒退覆盖。

## 功能清单

| 领域 | 能力 |
| --- | --- |
| Provider | 增删改查、API 接口格式（OpenAI Responses / Completions / Anthropic / 兼容 / 自定义）、自定义 Base URL 与额外 Header、API Key 走 Secrets、启用/禁用 |
| Model | 增删改查、所属 Provider、参数、Alias、运行时自由选择 |
| Project | 长期存在的代码库配置：Git Source（HTTPS / SSH / GitHub / GitLab / Gitee / 通用 / 公开 / 私有）、默认分支、执行默认值（Runtime/Model/Env/Secrets/超时/资源限制/网络策略）、Skills、MCP、Validation、Git publish 策略 |
| Source Credential | 独立于 Project 的 Git 凭据（HTTPS Token / SSH Private Key），敏感值走 Secrets，仅在单次 Git 操作期间临时materialize；公开仓库无需凭据 |
| Task Lifecycle | Project-based Coding Task 全生命周期：Managed Workspace → Source Preparing（clone/fetch/base ref/working branch）→ **强制隔离 Runtime** → Agent → **隔离 Validation** → Git Finalization（**冻结 final revision**）→ Publish（**只发布冻结 revision**）→ Cleanup；阶段与 agent/validation/finalization/publish 状态分别、单调地记录 |
| Git Publish | 平台负责 commit 策略与 push：只推本 Task 的 working branch、绝不 force、保护分支拒推、push 结果以远端实际状态为准（可重试且幂等） |
| Runtime | OpenCode / Pi / Codex / Claude Code / DSH / Docker / Mock，统一 Adapter 协议，可扩展 |
| Container / Sandbox | Docker 容器创建/销毁、CPU/Memory 限制、Workspace 挂载、Env/Secret 注入、网络策略、生命周期、超时 |
| Workspace | Managed Workspace（由 Project+Task 自动创建、Task 独占、durable）与 External Workspace（本地目录 / Git / Volume / 导入），持久化，与 Run 关联 |
| Task | 指定 Runtime / Model / Workspace / Env / Secrets / 资源限制 / 超时 / Policy；软删除后保留 30 天可恢复，过期物理清理 |
| Run | Pending→Starting→Running→Completed/Failed/Cancelled/Timeout，细粒度 phase（workspace/source/runtime/agent/validation/finalization/push/cleanup），查看/取消/重跑 |
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
* **Resources** — `Projects`（项目与 Coding Task 生命周期）、`LLM`（Provider 与 Model 列表及编辑）、`Runtimes`、`Native sessions`、`Handoffs`、`Workspaces`、`Source credentials`。
* **System** — `Runs`、`Usage`、`Proxy`、`Settings`。

Agent Profiles 目前仅通过 API 与 CLI 提供，Web UI 未开放入口。

### Projects（`/projects`、`/projects/:id`、`/projects/:id/tasks/new`）

Projects 页列出项目并支持创建（名称 / Repository URL / Credential（可选）/ 默认分支 / 默认 Runtime / 默认 Model / Validation / publish 策略）。项目详情页展示 Source、Credential（只显示掩码）、默认值、Skills、MCP、Validation 与 publish 策略，并列出该项目的 Task 及其生命周期（phase / agent / validation / publish）与按失败阶段提供的 retry 操作。

`/projects/:id/tasks/new` 是 Project-based Coding Task 的创建页：Instruction、Base ref、Working branch（留空即自动生成 `af/<task>-<slug>`）、Branch mode（new / continue）、Runtime / Model 覆盖、Validation 覆盖。**不需要也不能手工创建 Workspace**。

### Task Lifecycle（`/tasks/:id/lifecycle`）

Task Detail 页面回答「Agent 现在到底在开发、测试、提交，还是 push」：Project / Source、Base Ref 与 Base Commit、Working Branch、Workspace、Current Phase、Agent / Validation / Publish 三个状态、Final Commit、Remote Branch、Validation 每个 step 的输出，以及可用的 Retry（agent / validation / publish）与 Cancel。运行中每 2 秒自动刷新。

Tasks 列表中 Project-based Task 额外显示 working branch 与三个状态，行菜单提供 Lifecycle 入口。

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

生命周期属于 **Task**，在创建 Task 时选定，此后**不可修改**：该 Task 的每一个 Run（首轮、continue、retry、handoff）都继承同一个策略，不存在中途漂移。它既不是 Runtime 的属性（同一个 Runtime 服务需求不同的 Task），也不是按 Run 的覆盖项（下一轮悄悄换回另一种策略，正是这个模型要消除的意外）。

创建时未指定即 `ephemeral`，该决定在创建那一刻固化到 Task 记录上（`taskLifecycle()`），Run 创建时原样拷贝一份快照——因此没有任何读取路径需要推导、兜底或修补这个值。

`GET /api/containers/kept` 与 `af containers kept` 可查看 keep-alive 保留中的容器。

### Workspace

Workspace 是持久、Runtime-neutral 的一等资源，**是 Task 的 durable working copy，而不是 Runtime Container 本身**。容器可随意销毁重建而 Workspace 独立存在。

Workspace 分两类（详见「Project：Coding Task 生命周期」）：

* **Managed Workspace**：Project-based Task 由平台自动创建并独占（`ownership: "managed"`，1 Task = 1 Workspace），用户不手工创建；Task 被物理清理时随之清理。
* **External Workspace**：下面这些手工创建 / 导入的能力保持不变（`ownership: "external"`，平台不接管、不删除）。
  * **Create / Import**：新建空目录，导入已有本地目录或 Git 仓库（`git` 类型在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`）。
  * **Attach**：Run 时挂载进容器。
  * **Save**：Run 结束后校验并记录 `lastSavedAt` / `lastSavedRunId`。
  * **Usage**：`GET /api/workspaces/:id/usage` 查看被哪些 Task/Run 引用，并记录目录 `status`（`ready` / `missing`）。
* **Lock**：同一个 Managed Workspace 同一时刻只有一个 active writer；`GET /api/workspace-locks` 可查看当前持有的锁。

## Project：Coding Task 生命周期

AgentFabric 除 Handoff 之外的另一条核心能力：**围绕一个代码项目，在隔离 Runtime 中完成从源码准备、Agent 开发、任务状态管理，到最终 Git 分支推送的完整生命周期。**

```text
Project defines the codebase.   我正在开发哪个项目
Task    defines the intent.     我要完成什么需求
Workspace holds the work.       该 Task 的实际代码状态放在哪里
Run     executes the agent.     一次具体的 Agent execution attempt
Runtime is disposable.          Agent 此刻在哪里执行（可销毁）
Supervisor owns the lifecycle.  谁负责整条执行链
```

### Project

Project 是长期存在的顶层业务资源：一个你希望 AgentFabric 持续开发工作的代码库。它持有 **Source（Git 仓库）**、**执行默认值**（Runtime / Model / Profile / Env / Secrets / Timeout / Resource Limit / Network Policy）、可选的 **Skills** 与 **MCP Servers**、**Validation** 与 **Git publish 策略**。

配置继承关系：`Global Settings → Project → Task → Run`（显式给出的层级覆盖上一层，`undefined` 表示「此处未配置」而不是「覆盖为空」）。

Project 是 Task 的上游资源：

```text
Project
  └── Task            （一个 Project 可以有多个 Task）
       └── Workspace  （1 Task = 1 Managed Workspace）
            └── Run   （1 Task = N Runs，共享同一个 Workspace）
```

创建 Project 只需要：**名称、Repository URL、（可选）Credential、默认分支**。Web UI 的 Projects 页、`af projects add`、`POST /api/projects` 三条路径等价。

### Source

当前版本一个 Project 有且只有一个 primary source，类型为 `git`。Source 保存：

* `remoteUrl`：**绝不含凭据**的远端地址（`https://…` / `ssh://…` / `git@host:path` / 本地绝对路径）；
* `defaultBranch`：Task 未指定 base ref 时的默认起点；
* `provider`：由 host 推断（github / gitlab / gitee / generic）；
* `credentialId`：可选，指向 Source Credential；**公开仓库不需要**。

URL 在写入前校验：内嵌凭据（`https://user:token@host/repo.git`）、未知 scheme、控制字符、`-` 开头一律拒绝（`source-url-invalid`），不会变成命令。当前不支持一个 Project 多 Repository / monorepo 多 Source / mirror / submodule 独立管理，但模型不会阻碍将来扩展（`Project.source` 旁边加列表即可）。

### Source Credential

Source Credential 属于 **Settings / Global Configuration** 层，而不是 Project 私有数据；Project 只保存引用。

* 类型：`https-token`（HTTPS Token）与 `ssh-key`（SSH Private Key）；`username` / `host` / `knownHosts` 是非敏感元数据。
* 敏感值（token / private key / passphrase）**永远是 Secret**：创建时写入 Secrets，之后 API 只返回掩码；`af source-credentials list` 同样只见掩码。
* 设计上允许将来扩展 GitHub App / GitLab Access Token / Deploy Key / Short-lived Credential / OAuth（新增 `type` 与 materialize 分支即可）。
* 公开仓库：`credential = none`，创建 Project 时不会被强制要求提供凭据。

配置方式：

```bash
# HTTPS（Personal Access Token）
af source-credentials add-https "Personal GitHub" --host github.com --username octocat --token ghp_xxx

# SSH（私钥 + 可选 passphrase + 可选 known_hosts）
af source-credentials add-ssh "Internal Git" --host git.internal --key-file ~/.ssh/id_ed25519 \
  --passphrase '***' --known-hosts-file ~/.ssh/known_hosts

# 公开仓库：什么都不配
af projects add "agent-fabric" --repo https://github.com/org/agent-fabric.git --branch main
```

### Project Task Runtime Policy：Coding Task 必须运行在隔离 Runtime

> **Project Coding Task 默认只能运行在 isolated Runtime。** 普通的 Project Coding Task 不允许使用 Local Host Runtime。

判断依据是 **Runtime 的 isolation metadata**，而不是 Runtime 名字或 kind：

```text
runtime.executionBackend = "isolated"   （旧记录由 containerized 推导，无需迁移）
runtime.containerized    = true
runtime.image            存在
        ↓
runtimeIsolation(runtime).sandboxed = true   → 允许
```

三者缺一即不构成隔离承诺（例如「声明 isolated 但没有 image」的 Runtime 根本无法启动，也不算隔离）。

* 用户显式选择不满足要求的 Runtime 时，在 **Task / Run 创建之前**拒绝：`runtime-not-isolated`（HTTP 403）。不会先启动再失败。
* 没有显式指定时，自动选择的候选只包含隔离 Runtime；一个都没有就报错，**不会静默降级**到 Host Runtime。
* `GET /api/runtimes/:id/isolation` 返回判定结果；`GET /api/runtimes/project-eligible` 返回可用于 Project Task 的 Runtime 列表（Projects / New Task 页读它，因此界面上不会出现会被拒绝的选项）。
* **Local Runtime 依然保留**：development、debugging、non-project task、advanced usage、internal test 都继续可用。只有 Project Coding Task 受约束。
* 高级逃生阀：`allowHostExecution`（`SupervisorOptions` 或 `Project.execution.allowHostExecution`，默认关闭）。这是 operator 级别的显式安全策略，**Task 请求体无法自行开启**。开启后仅放宽 Agent Runtime；Validation 的隔离要求不受它影响。

### Validation：不可信代码，必须在隔离环境执行

> Repository validation command 视为不可信代码，因此在 sandbox 中执行，而不是 AgentFabric Host。

`npm test` / `npm run build` / `pytest` / `cargo test` / `make test` 都会执行仓库里的代码，因此 Validation **不再**通过 `sh -c` 在宿主上运行。默认实现是 **Option B：每次尝试创建一个 disposable validation container**：

```text
Agent finished
    ↓
（Agent Runtime 已销毁）
    ↓
disposable validation container（同一个 Workspace 只读/读写挂载）
    ↓
validation steps
    ↓
container 销毁
```

Validation 环境按 **allowlist** 构建，绝无 `...process.env` 兜底：

```text
Workspace（唯一挂载的宿主路径）
必要 runtime environment（PATH / HOME / TMPDIR / LANG / CI / AGENTFABRIC_VALIDATION）
明确允许的 Task env
明确允许的 build/test secret（Project/Task 的 validationSecretIds，scope 不得为 git）
```

Validation **不会**获得：Git Source Credential、所有 Task Secret、Docker socket、Workspace 以外的宿主文件系统、宿主 `process.env`。

* 每个 step 仍然记录 `status / exitCode / durationMs / output`，并产出 `validation-report.txt`；
* `validation.execution` 记录隔离证据（`backend: "isolated"`、`runtimeKind`、`image`、`disposable`）；
* 事件新增 `validation.runtime.prepared`，`shell.command` / `validation.started` 带 `isolated: true`；
* Validation 阶段保持独立：`validation.pending / running / completed / failed`，**Validation 失败不会覆盖 `agent.completed`**；
* Validation Runtime 本身起不来（没有 Docker daemon、image 不存在）报 `validation-runtime-failed` / `validation-runtime-unavailable`，**绝不回退到宿主执行**。

### Source Credential：Host Binding 与 Transport 兼容

> Source Credential 只用于 Source Manager / Publisher，不属于 Agent Runtime Secret。

使用凭据前先从 Repository Remote URL 解析真实 Host 与 transport，再验证：

```text
https://github.com/org/repo.git    → { https, github.com }
git@github.com:org/repo.git        → { ssh,   github.com }
ssh://git@gitlab.com/o/r.git       → { ssh,   gitlab.com }
/srv/git/repo.git                  → { local }
```

* **Host binding**：`credential.host` 必须覆盖 remote host。支持精确匹配与 `*.internal.example.com` 形式的 wildcard（wildcard 只覆盖子域，不覆盖裸域）。不匹配 → `credential-host-mismatch`。未设置 `host` 视为用户有意不限定范围。
* **Transport 兼容**：`https-token` 只能用于 HTTPS remote，`ssh-key` 只能用于 SSH remote。不兼容 → `credential-transport-mismatch`，**不静默降级**（HTTPS token 不会被拿去走 SSH 认证路径，SSH key 也不会被当作 HTTPS token）。
* **尽早失败**：Project create / update 时就检查（配置错误不该等到 clone 才暴露）；`startTask` 与每次 Git 操作前再检查一次。
* **凭据永不被发送到未授权 Host**。

### Secret Scope：授权边界，而不是描述信息

> `scope = git` 的 Secret 只能被 Git Credential Broker 使用。

`scope` 是**底层强制执行的授权机制**（`packages/core/src/secrets.ts`），不是给调用方自觉遵守的约定：

| Scope | 谁可以使用 |
| --- | --- |
| `git` | **只有** Credential Broker（clone / fetch / remote inspection / push） |
| `provider` | Provider API key（控制面） |
| `validation` | Validation 环境（build/test secret） |
| `mcp` | 生成的 MCP 配置 |
| `runtime` / `env` / `service` | 通用 Agent Runtime 环境 |

强制执行点在 **Secret resolution boundary**（`SecretService.resolve(ids, purpose)`），而不是 UI 或 Task API 的过滤：

* `git` scope 的 Secret 通过 **Task `secretIds`** 注入 Runtime → `secret-scope-not-allowed`，拒绝；
* 通过 **Runtime `secretIds`** → 拒绝；
* 通过 **Project `execution.secretIds`** → 拒绝；
* 被 **MCP server** 引用 → 拒绝（`resolveSecret` 走同一个 scope 检查）；
* 被 **Validation** 引用 → `validation-secret-not-allowed`，拒绝；
* **即使调用底层 Secret resolve API**（`SecretService.resolve`，默认 purpose 是 `agent-runtime`）也执行同一套 policy。

只有 `SourceCredentialService.resolve()`（Credential Broker）可以读 `git` scope 的 Secret，它自己也会断言 scope。这样即使未来新增调用路径，也不能意外把 Git Credential 注入 Agent。

### Git Credential 的防泄漏保证

敏感值不得进入 log / event / API response / error / stdout / stderr / `.git/config` / remote URL / Task metadata / Run metadata：

* **HTTPS**：token 只存在于 `GIT_ASKPASS` helper 读取的**子进程环境变量**，`https://TOKEN@host/repo.git` 形式永不持久化；remote URL 始终不含凭据；
* **SSH**：private key 临时 materialize 成 `0600` 文件、操作后立即 cleanup、不放入 Workspace、不进入 Agent Runtime；
* 所有生命周期事件与错误消息经过统一 `SecretRedactor`；
* `packages/core/src/v11.credential.test.ts`、`v11.docker.real.test.ts` 与 `scripts/e2e-v11-docker.sh` 用可识别的 fake secret（`AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK`）扫描 logs / events / errors / DB metadata / Workspace / `.git/config` / Runtime stdout-stderr 确认无泄漏。

### Credential Security Boundary

Git Credential 不会作为长期环境变量、命令参数或 Repository URL 暴露给 Agent：

* **HTTPS**：token 只存在于 `GIT_ASKPASS` helper 脚本读取的**子进程环境变量**里，配合 `-c credential.helper=` 禁用任何凭据缓存；token 不进入 argv、不进入 `.git/config`。
* **SSH**：私钥 materialize 成 `0600` 的临时文件，通过 `core.sshCommand` 显式指定 `-i <key>`；始终 `StrictHostKeyChecking=yes`（host key 必须验证，缺省用宿主的 `~/.ssh/known_hosts`，绝不静默信任）；passphrase 通过 `SSH_ASKPASS_REQUIRE=force` 交付。
* 一次 Git 操作结束后立即删除临时目录；push 需要凭据时再 materialize 一次。
* **Agent 拿不到仓库写凭据**：Agent Runtime 的环境变量、工作目录与挂载里都没有它。
* **脱敏**：所有生命周期事件与错误消息经过统一的 `SecretRedactor`，凭据值不会出现在 Log / Event / API Response / Runtime stdout-stderr / error / `.git/config` / task metadata 中（`packages/core/src/v11.test.ts` 与 `scripts/e2e-v11.sh` 都有断言）。

### Task：从 Project 创建 Coding Task

创建 Task 时可以选择：

```text
Select Project
Base Branch / Ref          （默认取 Project 的 default branch）
Working Branch
  - Generate               （系统生成 af/<task-id>-<slug>）
  - Custom                 （用户自定义，非法分支名直接拒绝）
Task Instruction
Runtime / Harness / Model  （可选覆盖 Project 默认值）
Validation                 （可选覆盖 Project 默认值）
Start
```

**baseRef 与 workingBranch 是分离的两个概念**：

```text
baseRef       = main               （会移动的引用）
baseCommitSha = 7c9f…              （Task 启动时解析出的真实 revision，之后冻结）
workingBranch = af/task_x-add-model（本 Task 拥有并负责发布的分支）
```

系统记录 `baseCommitSha` 的原因正是 `main` 会移动而 commit SHA 不会：任何时候都能回答「这个 Task 最初是基于哪个具体 commit 开始开发的」。

Branch 语义：默认 `branchMode: "new"`——**新 Task 创建新 working branch，绝不默默覆盖已存在的本地或远程分支**（`branch-conflict`）。想接着已有分支开发必须显式 `branchMode: "continue"`（此时 `baseCommitSha` 记为该分支当时的 tip；分支不存在则 `branch-not-found`）。分支名按 git 自身规则校验（`branch-invalid`），保护分支（默认 `main` / `master`）不能作为 working branch。

### Workspace：Task 的 durable working copy

**Workspace 是 Task 的持久工作副本，而不是 Runtime Container 本身。** 它不再承担 Project Definition 的职责。

* **Managed Workspace**：Project-based Task 创建时由平台自动生成（`1 Task = 1 Managed Workspace`），位于 `AGENTFABRIC_DATA_DIR/workspaces/<workspaceId>`，Task 独占，不同 Task 即使来自同一个 Project 也不共享 working tree。用户永远不需要手工创建。
* **External Workspace**：本地目录 / Git / Volume / 导入的已有目录，用于高级场景与兼容既有能力（`ownership: "external"`，平台不接管、不复制、不删除）。
* **Durable**：`Runtime Container 生命周期 != Workspace 生命周期`。容器可随时销毁重建，Workspace 与其未提交的修改始终保留；Task 被物理清理（软删除满 30 天）时，它自己的 Managed Workspace 才随之清理，External Workspace 永不受影响。
* **Workspace Lock**：一个 Managed Workspace 同一时刻只有一个 active writer。第二个写入者拿到 `workspace-locked`，而不是让两个 Run 同时改同一棵 working tree；锁在 Run 结束/取消时释放，持有者 Run 已不活跃的锁视为陈旧并自动回收（这也是崩溃恢复的一部分）。

### Run：一个 Task 可以拥有多个 Run

一个 Task 可以执行多个 Run，这些 Run 共享同一个 Task Workspace：Runtime 重启、Handoff、Harness 切换、Agent 失败、用户重新执行都会产生新的 Run，而 Workspace 中的代码修改持续存在。

Run 保留粗粒度 `status`（Pending → Starting → Running → Completed / Failed / Cancelled / Timeout），并新增细粒度 `phase`：

```text
task.created → workspace.preparing → source.fetching → source.checkout
→ runtime.preparing → agent.running → validation.running
→ git.finalizing → git.pushing → cleanup → completed / failed / cancelled
```

### Runtime：disposable execution environment

Runtime 是**可销毁的执行环境**。每次 Run 按 **Task 的 lifecycle 策略**创建容器（默认 `ephemeral`：Run 结束即销毁；策略在创建 Task 时选定，见「容器生命周期」）。Workspace 与 Runtime Native State 以挂载方式注入。

Runtime 声明自己的 **execution backend**（`executionBackend: "isolated" | "host"`，旧记录由 `containerized` 推导）。这不是描述性字段：Project Coding Task 的 isolation gate 就读它（配合 `containerized` 与 `image`），因此新增 Runtime 时不要依赖名字或 kind 判断隔离能力。容器销毁不会影响 Workspace，也不会影响 Harness 的 Native Session（Native State 是 Harness 私有状态，与 Workspace 严格区分，两者不混在一起）。Task 之间彼此隔离：独立 Workspace、独立 working branch、独立 Runtime、独立 execution state，Secret 不会被无关 Task 获取。

### Supervisor：完整 execution lifecycle 的负责人

`ExecutionSupervisor`（`packages/core/src/supervisor.ts`）位于 **Control Plane**，负责整个 Task / Run 生命周期，而不是 Agent 的一部分：

```text
AgentFabric Control Plane
        ↓
Execution Supervisor
        ↓
Agent Runtime Container
```

职责：

* **Workspace lifecycle**：prepare / lock / attach / preserve / cleanup 临时资源；
* **Source lifecycle**：clone / fetch / checkout / branch / revision resolve；
* **Credential lifecycle**：resolve / 临时注入 / 撤销清理 / 防泄漏；
* **Runtime lifecycle**：create / monitor / timeout / stop / cancel / destroy；
* **Runtime provisioning**：Harness / Skill / MCP / Agent / Model / environment / Native State mount / Workspace mount；
* **Execution monitoring**：process exit、heartbeat、stdout-stderr、结构化事件、cancellation、timeout；
* **Finalization**：inspect repository state、commit、**冻结 final revision**、push 该 revision、记录 publish 结果；
* **Runtime isolation gate**：在 Task 创建前拒绝不满足隔离要求的 Runtime；
* **Validation lifecycle**：在隔离 Runtime 中执行 validation step，按 allowlist 构建环境；
* **Credential broker**：只在单次 Git 操作期间 materialize 凭据，并校验 host binding 与 transport 兼容性；
* **Stage recovery**：崩溃重启后按 crash 时的阶段恢复，不倒退已完成的阶段。

Runtime Container 内只运行 Agent Harness（Runner 侧只做启动、信号转发、输出与结构化事件转发、退出码上报）；它不持有 Source Credential，也不承担 Project-level Git publish 权限。

### Skill 与 MCP provisioning

Project 可以配置默认 Skills（`skills: [{ name, path }]`）与 MCP Servers（`mcpServers: [...]`），Task 在允许范围内覆盖。Runtime 启动前 Supervisor 生成最终执行环境：

* 每个 Run 拥有独立的 provisioning 目录（`AGENTFABRIC_DATA_DIR/provisioning/<runId>`），可重复执行（重建而不是叠加）、不污染其他 Task、不依赖长期容器、跨 Runtime 可恢复，Run 结束即清理；
* Skills 以只读挂载注入（容器内 `/root/.agentfabric/skills`，本地执行时环境变量 `AGENTFABRIC_SKILLS_DIR` 指向宿主目录）；skill 目录不存在即响亮失败；
* MCP 配置由**控制面配置生成**（`AGENTFABRIC_MCP_CONFIG`，文件 `0600`，cleanup 时删除），Secret 引用在 provisioning 时解析注入；**仓库内容不能自行申请** Production Credential、任意 Secret、更高 Runtime 权限、任意网络访问或任意 publish 目标——`.agentfabric.yml` 之类的 Repository-local config 属于不可信输入，本期不读取、不执行。

### Validation

Project 定义默认 Validation，Task 可以覆盖（`typecheck` / `test` / `lint` / `build` 等，就是一行行命令）。Validation 在 Agent 结束后、Git Finalization 之前执行，工作目录是同一个 durable Workspace——但**执行位置是隔离 Runtime，不是宿主**（见上文「Validation：不可信代码，必须在隔离环境执行」）：

* 每个 step 记录 `status / exitCode / durationMs / output`，并产出一份 `validation-report.txt` artifact 挂在该 Run 上；
* 失败区分 `validation-failed` 与 `validation-timeout`；隔离环境本身起不来则是 `validation-runtime-failed` / `validation-runtime-unavailable`；
* **Validation 失败不会被混进普通的 `Task Failed`**：`execution.failure.stage = "validation"`，agent 状态保持 `completed`，也不会进入 publish；
* 可以**单独重试 validation**（`POST /api/tasks/:id/retry-validation`），不重新开发、不调用模型，同样在隔离 Runtime 内执行。

### Git Finalization

Agent 结束后平台检查仓库状态：当前 branch、working tree status、tracked changes、untracked files、Agent 产生的 commit、HEAD revision。

* **Agent 没有 commit 也没关系**：默认 `autoCommit: true` 时平台会把剩余改动（含 untracked，遵守 `.gitignore`）补成一个最终 commit，所以「即使 Agent 没有主动 commit，Task 仍然能正确发布」。
* **不破坏 Agent 已有 commit**：不 squash、不 rebase、不丢弃；只有当仍有 dirty changes 时才**追加**一个最终 commit。
* 记录 `baseCommitSha` / `finalCommitSha` / `workingBranch` / `remoteBranch` / `pushedAt` / publish 结果。
* 纯 no-op Task（没有任何改动）仍会把 working branch 发布到 base revision，Task 正常完成。

### Frozen Final Revision：Finalization 成功后冻结 revision

首次 Git Finalization 成功后，平台**冻结**这次开发的最终结果：

```text
execution.frozenRevision = {
  finalCommitSha, baseCommitSha,
  workingBranch, remote, remoteBranch,
  workspaceFingerprint,     // HEAD + branch + porcelain status
  at, finalizations,
}
```

之后所有 Publish 都针对这个明确 revision 执行：push 的源是 **commit SHA**（`git push <remote> <sha>:refs/heads/<branch>`），而不是本地 branch ref。这样无论 Workspace 之后发生了什么，都不可能被顺带发布出去。事件 `git.revision.frozen` 记录冻结时刻。

### Retry Publish：重新发布已经 Finalize 的 commit

> Retry Publish 重新发布已经 Finalize 的 commit，不重新运行 Agent、不重新 Validation、不重新 Finalization。

`POST /api/tasks/:id/retry-publish` 是一个**纯发布操作**：

* 不运行 Agent；不运行 Validation；不重新 Finalization；
* **不创建新的 commit**；不修改 Workspace；不重新计算 `finalCommitSha`；
* 只把 `frozenRevision.finalCommitSha` 重新 push 到当前 Task 已登记的 remote / working branch。

如果 Finalization 之后 Workspace 又被修改（新 commit、checkout、甚至只是一个 untracked 文件），Retry Publish **不会**把这些修改一起发布：

```text
workspace-diverged-after-finalization
```

它对比的是冻结时记录的 `workspaceFingerprint`。要发布新改动，必须显式开一个新的 Agent Run 重新 Finalize（此时 `finalizations` 递增，冻结 revision 前进到新的 commit）。

并发上，Retry Publish 会获取同一个 Workspace 写锁，因此不会与正在修改同一 Workspace 的 active Run 产生竞态（`workspace-locked` / `task-busy`）。

### Publish 目标限制

Publish 只能针对当前 Task 已登记的 `remote` / `working branch` / `final commit`：

* 不允许 arbitrary branch；不允许 arbitrary remote；**不允许 force push**；不允许 push tag。

`GitOps` 的 push 契约本身没有 force 参数，refspec 显式且固定为 `refs/heads/<branch>`；protected branch（默认 `main` / `master`）直接 `policy-denied`。

### Git Push：平台能力

Git Push 是 Supervisor / Platform 的能力，不是 Agent 可任意调用的工具：

* 只推**本 Task 的 working branch**（显式 refspec `refs/heads/<branch>:refs/heads/<branch>`）；
* **绝不 force push**（本版本没有 force 选项，也没有 force policy）；
* 保护分支拒推（`policy-denied`）；
* 远端分支不是本 Task 创建的 → `remote-branch-conflict`，而不是覆盖；
* 网络/认证失败 → `git-push-failed` / `git-push-auth-failed`；远端拒绝（分叉）→ `git-push-rejected`。

### Development Completed 与 Publish Failed 分开

重点场景：Agent 已经完成开发、代码已在 Workspace、commit 已生成，但 push 因网络或 credential 失败。此时**不会重新执行 Agent**：

```text
Development = Completed   （agent: completed, validation: passed）
Publishing  = Failed      （failure.stage = "publish", publish.status = "failed"）
```

三种 Retry 语义明确分开，没有笼统的 `Retry Task`：

| Retry | 入口 | 语义 |
| --- | --- | --- |
| **Retry Agent Run** | `POST /api/tasks/:id/retry-run` | 新建一个 Run，继续使用同一个 Workspace（已有改动保留） |
| **Retry Validation** | `POST /api/tasks/:id/retry-validation` | 只重跑 validation，不重新开发、不调用模型 |
| **Retry Publish** | `POST /api/tasks/:id/retry-publish` | 只把已 commit 的 revision 重新 push，不重新执行 Agent |

**幂等与崩溃恢复**：重复执行的生命周期步骤都可安全重试——workspace 目录已存在即复用；branch 只在 Task 首次启动时创建，之后是 checkout 复用；push 之前先读远端实际 revision，若远端已有我们的 commit 就直接记为成功（`push 超时但其实已成功` 的情况由此收敛）；push 报错后再问一次远端，若已落地也算成功。

Supervisor / API Server 重启后按 **crash 时的阶段**做 stage-specific recovery（`packages/core/src/supervisor.ts` 的 `recoverInterrupted()`）：

| crash 发生在 | agent | validation | finalization | publish | 给出的下一步 |
| --- | --- | --- | --- | --- | --- |
| `agent.running` | failed | — | — | — | Retry Agent |
| `validation.running` | **completed** | interrupted | — | — | Retry Validation |
| `git.finalizing` | **completed** | **completed** | interrupted | — | Retry Agent |
| `git.pushing` | **completed** | **completed** | **completed** | interrupted/failed | Retry Publish |
| `cleanup`（只丢了终态写入） | completed | completed | completed | completed | 无（Task 直接收敛为 completed） |

**Recovery 不会反向破坏已经成功的状态**，也不会自动重新执行 Agent；Workspace 与其中未提交的修改保留，锁被回收，事件 `task.recovered` 记录判定结果。

### Cancellation

用户随时可以取消正在执行的 Task / Run（`POST /api/tasks/:id/cancel`）：终止 Runtime 进程与正在进行的 Git 操作、进入 cleanup、**Workspace 保留**（当前代码修改不删除）、释放 Workspace lock、凭据及时清理、Task 状态准确记为 `cancelled`。之后可以基于同一个 Workspace 继续新的 Run。

### Task Detail / 可观测性

`GET /api/tasks/:id/detail`（Web UI 的 `/tasks/:id/lifecycle`、`af tasks detail <id>`）展示：

```text
Project / Source（含凭据名称与掩码，绝不含凭据值）
Base Ref / Base Commit
Working Branch
Workspace（managed/external + 路径）
Current Phase
Agent Status / Validation Status / Publish Status
Final Commit / Remote Branch
可用的 Retry（agent / validation / publish）
```

每次 Task / Run 都能追踪：Project、Workspace、Runtime、Harness、Model、base ref、base commit、working branch、Run phase、起止时间、exit result、validation result、final commit、publish result；所有生命周期关键操作都写入现有 Event / Logging 系统（`run.phase`、`workspace.prepared`、`source.prepared`、`runtime.prepared`、`credential.resolved` / `credential.released`、`provisioning.prepared` / `provisioning.cleaned`、`validation.runtime.prepared`、`validation.started` / `validation.step` / `validation.passed` / `validation.failed`、`git.finalized`、`git.revision.frozen`、`git.pushed`、`publish.retry.started`、`publish.failed`、`task.recovered`）。

**阶段可分辨（Stage observability）**：Task Detail 不只暴露一个 `Task failed`，而是分别表达每个阶段的结果——Agent / Validation / Finalization / Publish 各自的状态、错误码与时间，加上冻结的 revision：

```text
Agent         completed
Validation    completed            ran in an isolated container (node:22-alpine)
Finalization  completed            commit = abc123
Publish       failed               [git-push-auth-failed] reason = auth failure
Frozen        abc123 → origin/af/xxx-add-model
```

`execution.stages` 是**单调**的：某个阶段一旦 `completed`，后续阶段的失败不会把它改写。`agent.status` 不会因为 `publish.failed` 变成 `failed`，`validation.status` 也不会因为 Retry Publish 失败而改变。

### 领域错误模型

失败带稳定 `code` 与 `stage`，API 按 stage 映射 HTTP 状态（404 / 409 / 403 / 502）：

```text
Source        source-url-invalid · source-not-found · source-auth-failed · source-network-failed
              source-credential-missing · source-credential-invalid
              credential-host-mismatch · credential-transport-mismatch
              base-ref-not-found · branch-invalid · branch-not-found · branch-conflict
Workspace     workspace-create-failed · workspace-locked · workspace-invalid
Runtime       runtime-create-failed · runtime-start-failed · runtime-lost · runtime-timeout
              runtime-not-isolated · runtime-not-allowed-for-project-task
              secret-scope-not-allowed
Agent         agent-start-failed · agent-failed · agent-timeout · agent-cancelled
Validation    validation-failed · validation-timeout
              validation-runtime-failed · validation-runtime-unavailable · validation-secret-not-allowed
Finalization  git-state-invalid · git-commit-failed
Publishing    git-push-failed · git-push-auth-failed · git-push-rejected · remote-branch-conflict
              publish-revision-missing · workspace-diverged-after-finalization
Platform      project-not-found · project-invalid · credential-not-found
              task-not-found · task-state-invalid · task-busy · policy-denied · supervisor-restarted
```

HTTP 映射：隔离/授权类失败（`runtime-not-isolated`、`credential-host-mismatch`、`credential-transport-mismatch`、`secret-scope-not-allowed`、`validation-secret-not-allowed`、`policy-denied`）为 **403**；并发/状态冲突类（`workspace-diverged-after-finalization`、`publish-revision-missing`、`workspace-locked`、`remote-branch-conflict`、`task-busy`、`task-state-invalid`、`branch-conflict`）为 **409**；`validation-runtime-*` 与 `runtime-*` 为 **502**。

### API

```text
Project
  GET    /api/projects                     列表
  POST   /api/projects                     创建（name, source{remoteUrl, credentialId?, defaultBranch?}, execution?, skills?, mcpServers?, validation?, git?）
  GET    /api/projects/:id                 详情
  PUT    /api/projects/:id                 更新
  DELETE /api/projects/:id                 删除
  GET    /api/projects/:id/tasks           该项目的 Task
  POST   /api/projects/:id/tasks           创建并启动 Coding Task（instruction, baseRef?, workingBranch?, branchMode?, runtimeId?, modelId?, validation?, git?）

Source Credential
  GET    /api/source-credentials           列表（只含掩码）
  POST   /api/source-credentials           创建（name, type, host?, username?, value?, passphrase?, knownHosts?, secretId?）
  GET    /api/source-credentials/:id       详情（只含掩码）
  PUT    /api/source-credentials/:id       更新（value / passphrase 可轮换）
  DELETE /api/source-credentials/:id       删除（连同其 Secret）

Task lifecycle
  GET    /api/tasks/:id/detail             Task Detail 读模型（§40 全部字段 + isolation + stages + frozenRevision + 可用 retry）
  POST   /api/tasks/:id/cancel             取消（终止 Runtime 与 Git 操作，Workspace 保留）
  POST   /api/tasks/:id/retry-run          新 Run 继续同一 Workspace
  POST   /api/tasks/:id/retry-validation   只重跑 validation（同样在隔离 Runtime 内）
  POST   /api/tasks/:id/retry-publish      只重新 push 冻结的 revision（不重新执行 Agent / Validation / Finalization）
  GET    /api/workspace-locks              当前持有的 Workspace 写锁
```

Runtime isolation
  GET    /api/runtimes/project-eligible    可用于 Project Coding Task 的 Runtime（isolated 且可用）
  GET    /api/runtimes/:id/isolation       isolation 判定（sandboxed / executionBackend / image / reason）
```

`GET /api/dashboard` 的 `counts` 增加 `projects` 与 `sourceCredentials`。既有 Task / Run / Workspace / Handoff / Secret / Event API 未做破坏性变更（新字段全部可选）。

### Handoff 兼容

Project-based Task 同样支持既有 Handoff / Native State / Resume：Workspace 表示**用户代码与 working tree state**，Native State 表示**Harness 私有 session state**，二者不混。本期实现没有改动 Handoff 的生成、投影与渲染路径。



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

* 数据保存在 `~/.fabric/db.json`（可用 `AGENTFABRIC_DATA_DIR` 覆盖到任意目录），原子写入。Project / SourceCredential / WorkspaceLock 与既有集合一样存在同一个 store 里。
* Run 事件不进 db.json：事件负载按 run 分片，append-only 追加到 `~/.fabric/events/<runId>.jsonl`；db.json 只保留每 run 一行的索引（`eventShards`：文件、条数、字节数、`lastSeq` 高水位，`lastSeq` 同时用于重启后恢复全局 seq 计数器）。读取按需从分片文件载入。
* `git` 类型 Workspace 在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`，Run 时挂载真实目录；Project-based Task 的 Managed Workspace 同样落在这里，由平台自动创建与（软删除满 30 天后）自动清理。
* Secrets 值仅在创建时返回一次，其余接口返回掩码；Secrets 不进入日志与事件；按 `secretIds` 注入 Runtime 环境变量。
* Git 凭据只在单次 Git 操作期间 materialize 到 `AGENTFABRIC_DATA_DIR/git-credentials/<op>-<random>`（操作结束立即删除）：HTTPS 走 `GIT_ASKPASS` + 子进程环境变量，SSH 走 `0600` 私钥文件 + `core.sshCommand`（`StrictHostKeyChecking=yes`）。远端 URL 始终不含凭据，`.git/config` 里也没有。
* Skill / MCP provisioning 落在 `AGENTFABRIC_DATA_DIR/provisioning/<runId>`，Run 结束即删除；生成的 MCP 配置是 `0600` 文件（可能含注入的 Secret 值），同样不进入日志与 API 响应。
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
af runtimes list | add | enable | disable | remove
af runtimes add "OpenCode" --kind opencode
af runtimes add "Pi Agent" --kind pi
# Project Coding Task 需要隔离 Runtime：--isolated（或 --containerized）声明 isolated 执行，
# 必须同时给出 --image；--host 声明 host 执行（仅 development / 非 Project 任务）。
af runtimes add "My Docker" --kind docker --isolated --image node:22-alpine --command "sh -c echo hi"

# Workspace / Agent Profile / Secrets
af workspaces add repo --path /path/to/code
af workspaces import legacy --path /existing/project    # 导入已有目录
af workspaces save <ws-id> --run <run-id>
af workspaces usage <ws-id>
af agents add "Senior Engineer" --runtime <rt> --model <model> --system-prompt "You are a senior engineer"
af secrets add my-key --value sk-xxx --scope env

# Project / Source Credential / Coding Task 生命周期
af source-credentials list | add-https | add-ssh | update | remove
af source-credentials add-https "Personal GitHub" --host github.com --username octocat --token ghp_xxx
af source-credentials add-ssh "Internal Git" --key-file ~/.ssh/id_ed25519 --known-hosts-file ~/.ssh/known_hosts
af projects list | show <id> | add | update | remove | tasks <id>
af projects add "agent-fabric" --repo https://github.com/org/agent-fabric.git --branch main
af projects add "private" --repo git@github.com:org/private.git --credential <cred-id>
af projects start <project-id> "给 README 补充用法" --base main --follow
af projects start <project-id> "接着改" --working-branch af/existing --branch-mode continue
af tasks detail <task-id>        # Project / Source / base commit / branch / phase / 三个状态 / final commit / retry
af tasks cancel <task-id>        # 终止 Runtime，Workspace 保留
af tasks retry-run <task-id> "继续修剩下的"   # 新 Run，复用同一 Workspace
af tasks retry-validation <task-id>          # 只重跑 validation，不重新开发
af tasks retry-publish <task-id>             # 只重新 push，不重新执行 Agent

# 提交任务（lifecycle 在此选定，此后该 Task 全程沿用）
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
             Execution Supervisor（Project Task 生命周期）、Git 操作与凭据隔离、
             Validation、Skill/MCP provisioning、领域错误模型、脱敏、
             Runtime 协议、Handoff 组装与渲染、Policy、Proxy、生命周期
  runtimes/  Runtime Adapters：mock / opencode / pi / codex / claude-code /
             dsh / docker，以及各 Harness 的本地会话探测与 Execution Backend
  server/    Express REST API + SSE + 静态 Web UI 托管
  cli/       af 命令行（对接 REST API）
  web/       React + Vite Web UI
docker/      pi.Dockerfile（容器化 Pi 的参考镜像）
scripts/     e2e-v11.sh（Project Coding Task 生命周期的端到端验证脚本）
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
* Workspace 的 Snapshot / Fork / Diff 等高级能力未提供（Managed Workspace 的 Lock 已提供）。
* **Project Coding Task 本期边界**：
  * 一个 Project 只支持一个 primary source（单 Repository）；monorepo 多 Source、mirror、submodule 独立管理未实现。
  * Source Credential 只实现 HTTPS Token 与 SSH Private Key；GitHub App / Deploy Key / OAuth / Short-lived Credential 预留未实现。
  * `branchMode: "new"` 与 `"continue"` 已实现；force push 与 push tag 明确不支持（无选项、无 policy）。
  * Validation 在 disposable 隔离 Runtime 内执行（默认 Docker，workspace 挂载）；**不再**在宿主 `sh -c` 执行。非 Project 任务仍可使用宿主 runner。
  * Validation Runtime 复用 Task Runtime 的 image 作为工具链；`AGENTFABRIC_VALIDATION_IMAGE` 可覆盖默认值（`node:22-alpine`）。
  * 容器化的 Coding Task 需要 Docker daemon 可达；不可达时 validation 报 `validation-runtime-unavailable`，不会回退到宿主执行。
  * `allowHostExecution` 是 operator 级逃生阀（SupervisorOptions / Project.execution），默认关闭，Task 请求无法开启。
  * Skills provisioning 提供 canonical 目录 + 只读挂载 + `AGENTFABRIC_SKILLS_DIR`，是否被某个 harness 自动发现取决于该 harness；MCP 配置按统一 `mcpServers` 文档生成并通过 `AGENTFABRIC_MCP_CONFIG` 交付，未逐 harness 写入各自的私有配置格式。
  * Repository-local config（`.agentfabric.yml`）本期不读取（不可信输入），只在领域上划清 Control Plane Configuration 与 Repository Configuration 的边界。
  * Project 的 `execution` 继承模型已覆盖 Runtime / Model / Profile / Env / Secrets / Timeout / Resource Limit / Network Policy / Lifecycle / Tools；Secret references 与 Validation / Git publish 走 Project→Task 覆盖，Run 级仅继承 Task 快照。

## 测试

```bash
npm run typecheck                                # 全仓库类型检查
npm test                                         # 全仓库测试（node:test）
npm run test -w @agentfabric/core                # 只跑 core
npm run build                                    # 构建全部 workspace（含 Web 产物）
```

core 测试覆盖 store / secret / mock run / cost / event bus / policy / git workspace，容器生命周期策略与 keep-alive 租约，同 Harness Native Resume 与跨 Harness Handoff，Handoff 上下文选择、预算账目与渲染语义，能力声明与随执行后端收窄。

`src/v11.test.ts` 覆盖 Project / Source Credential / Coding Task 生命周期：Project 与 Credential 的创建与校验、公开与私有仓库、URL 与分支名校验、凭据 materialize 与脱敏、clone/fetch/base ref/working branch、分支冲突与 continue 模式、baseCommitSha 冻结、Validation（失败/超时/重试）、Git finalization（自动 commit / Agent 已有 commit / dirty + commit / no-op / autoCommit=false）、Publish（成功 / 认证失败 / 远端拒绝 / 冲突 / 重试 / 幂等）、并发隔离、Workspace lock、取消、崩溃恢复、Skill/MCP provisioning，以及 §41.11 的 Case A–F。Git 部分使用**真实 `git` CLI 与本地 bare 仓库**作为远端，只有 Agent Harness 是脚本化的。

v11 hardening 的专项测试：

| 文件 | 覆盖 |
| --- | --- |
| `src/v11.isolation.test.ts` | Runtime isolation metadata 判定、Host Escape（Project Task + local runtime 在执行前被拒）、隔离 Runtime 的 Validation（Case A–E）、allowlist 环境、宿主 secret 不可见、Git Credential 不可达、Validation failure 不倒退 agent |
| `src/v11.secretscope.test.ts` | Secret scope 授权边界 Case A–F：git scope 可用于 clone/push，经 Task/Runtime/Project secretIds、MCP、Validation 一律拒绝；底层 resolve API 同样执行 policy |
| `src/v11.credential.test.ts` | Remote host 解析、host binding（HTTPS/SSH match & mismatch、wildcard）、transport 兼容（HTTPS token × SSH remote 等）、Project create/update 尽早失败、`.git/config` 与全生命周期防泄漏 |
| `src/v11.publish.test.ts` | Frozen final revision、Retry Publish 是纯发布（同 commit、不新增 commit、不跑 agent/validation/finalization、SHA 不变）、workspace 漂移检测、stage-specific crash recovery（Agent/Validation/Finalization/Publish/Cleanup）、状态单调性、取消与并发 |
| `src/v11.docker.real.test.ts` | **真实 Docker** 全链路（Agent 在容器内、workspace mount、runtime 销毁、workspace 存活、Validation 在 sandbox 内、agent 环境无 Git Credential、精确 push 冻结 commit、无泄漏）。Docker daemon 不可达时 skip 并说明原因 |

端到端验证（真实 server + 真实 git 远端 + 真实 API/CLI）：

```bash
bash scripts/e2e-v11.sh          # 需要本机 git；使用临时数据目录与本地端口，不触碰 ~/.fabric
bash scripts/e2e-v11-docker.sh   # 额外需要 Docker daemon 与 node:22-alpine 镜像（可用 AGENTFABRIC_DOCKER_E2E_IMAGE 覆盖）
```

`scripts/e2e-v11-docker.sh` 走完整条验收链路：创建 git-scoped credential → Project → Task → Managed Workspace → clone → base commit → working branch → 真实 Docker Runtime → 容器内 fake agent 改 Workspace → 验证 agent 读不到 credential → Validation 在 disposable sandbox 内执行 → Finalize → 冻结 final SHA → push 该精确 commit → 销毁 container → 验证 Workspace 仍在 → 验证远端 branch → Retry Publish（含 workspace 漂移拒绝）→ 验证 secret 从未泄漏。

真实 Harness 集成测试（Pi/OpenCode × Local/Docker + 跨 Harness Handoff）默认 skip，使用真实 CLI、真实模型调用与真实容器：

```bash
AGENTFABRIC_REAL_INTEGRATION=1 npm test -w @agentfabric/core
# 可选：AGENTFABRIC_PI_IMAGE=<镜像>（否则自动从 docker/pi.Dockerfile 构建）
#       AGENTFABRIC_REAL_DEEPSEEK_KEY / DEEPSEEK_API_KEY（Pi 模型调用）
#       AGENTFABRIC_OPENCODE_AUTH_JSON（OpenCode 容器认证，缺省复用本机 auth.json）
```
