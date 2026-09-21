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
                  ┌─────────────┼──────────────┬──────────────┬─────────────┐
                  ▼             ▼              ▼              ▼             ▼
             OpenCode       Pi Agent        Codex         Docker        Mock
             Adapter        Adapter         Local         Adapter        Adapter
             (本地+容器)    (本地+容器)     (本地)         (容器)         (模拟)
                                │
                          Claude Code
                          Local (本地)
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
| Runtime | OpenCode / Pi Agent / Codex Local / Claude Code Local / Docker / Mock，统一 Adapter 协议，可扩展 |
| Container / Sandbox | Docker 容器创建/销毁、CPU/Memory 限制、Workspace 挂载、Env/Secret 注入、网络策略、生命周期、超时 |
| Workspace | 本地目录 / Git / Volume，持久化，与 Run 关联 |
| Task | 指定 Runtime / Model / Workspace / Env / Secrets / 资源限制 / 超时 / Policy；软删除后保留 30 天可恢复，过期物理清理 |
| Run | Pending→Starting→Running→Completed/Failed/Cancelled/Timeout，查看/取消/重跑 |
| Runtime Native Session | 只保存 Harness 原生 Session 的不透明引用（RuntimeSessionRef），同 Harness Native Resume，跨 Harness 走 Handoff；不存在统一的 AgentFabric Session |
| Runtime Native State | Harness 私有状态的持久化目录（Opaque），容器销毁后仍可恢复 Native Session |
| Events & Logs | 统一标准事件，REST 查询 + SSE 实时流 |
| Artifacts | 代码、Diff、Report、Test Result、Build Output、最终结果 |
| Usage & Cost | Input/Output/Cached Token、请求数、时长、估算成本，按 Model/Provider/日期聚合；Web UI 以日历热力图展示近 26 周的活动（可按费用 / Token 切换指标）。按日期聚合用的是**本机时区的日历日**，所以 UTC+8 晚上跑的任务算在当天，不会被切到第二天 |
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

打开 http://localhost:7377 查看 Web UI（New task / Tasks / Dashboard / Task Thread 对话式执行线程 / Run Inspector / Providers / Models / Runtimes / Native sessions / Agents / Workspaces / Handoffs / Artifacts / Usage / Settings）。

## Web 交互模型（v5）

> **Users interact with Tasks. The system executes Runs.**
> **Task is the product surface. Run is the execution detail.**

* **Task Thread（`/tasks/:taskId`）是主交互页面**：像 Codex / Claude Code 一样，用户消息（`run.userPrompt`，绝不是拼接后的完整 Harness Prompt）、Agent 工作过程（可读、默认折叠的 Tool / Command / File Activity）与 Agent 回答（`agent.message`）在同一页面持续展开；底部 Composer 继续任务，可切换 Runtime / Model / Agent Profile，并实时提示即将发生 **Resume**（同 Harness）还是 **Handoff**（跨 Harness，带 Context Bundle：checkpoint + 逐字保留的工作上下文）。运行中可 Stop，失败提供 Continue / Switch runtime 与「View run」调试入口；普通 turn 不暴露 Run 概念——Run 是执行细节，调试 / 审计走 Runs 页与 Run Inspector。
* **Run Detail 退回为 Run Inspector（`/runs/:runId`）**：高级执行详情 / 调试 / 审计页面——Raw Events、Logs、Artifacts、Usage、Runtime Native Session、Native State、Handoff 与完整 `inputInstruction`。
* **Runs 页可复制 Native Session id**：每个产生过 native session 的 Run 在操作列提供 **copy session id**——悬停可见完整 id 与该 harness 的 resume 命令（`claude --resume <id>` / `codex exec resume <id>` / `pi --session <id>` / `opencode --session <id>`），复制后可直接去原生 harness CLI resume；Run Inspector 的 native session 行提供同样的复制按钮。
* **前端 Presentation Layer**：Raw Event → Presentation Projector → Timeline Item（事件合并：`tool.started`+`tool.completed` → 一个 Tool Activity，`shell.command`+`shell.output` → 一个 Command Activity），不修改 Core Event Schema；`GET /api/tasks/:id/thread` 提供只读聚合，未引入新的 Message / Conversation / Session 后端模型。

## Task 删除与恢复（软删除 + 30 天保留）

* **删除入口（Tasks 页）**：每条 Task 行右侧的三点菜单提供 **Delete**。删除是**软删除**——写 `deletedAt` 时间戳后从 Tasks 列表消失，但对该 Task 的一切 scoped 读写（thread 页、continue、handoff、sync-thread、按 id 读取）表现为「不存在」（404）；它的 runs、事件、handoffs 等从属数据原样保留，不发生任何改写。
* **恢复入口（Dashboard）**：Dashboard 的 **Deleted tasks** 卡片显示已删除 Task 的数量，点击进入 `/trash`（Deleted tasks 页），每条可 **restore**——清除 `deletedAt` 后 Task 连同全部历史回到 Tasks 页。保留期内数据从未被动过，恢复即完整还原。
* **30 天后物理清理**：保留期 `TASK_RETENTION_MS` = 30 天。服务器启动时执行一次、之后每小时一次后台清理 pass，把 `deletedAt` 超过保留期的 Task **连同其 runs、run 事件 shard 文件、artifacts、handoffs、runtime session 引用一起物理删除**；清理失败打错误日志（失败要响，不静默跳过）。
* **API**：`GET /api/tasks` 默认只返回未删除 Task，`?deleted=true` 返回已删除列表；`DELETE /api/tasks/:id` 软删除；`POST /api/tasks/:id/restore` 恢复；`GET /api/dashboard` 的 `counts.tasks` 只计未删除 Task，`counts.deletedTasks` 为已删除数量。

## Codex Local 与跨 Harness Handoff（v6）

v6（`v6.md`）接入本机 **Codex CLI** 作为 Harness，核心目标是：用户在 Codex 里做到一半（额度耗尽或主动切换），能通过 AgentFabric 把工作自然交接给 Pi / OpenCode，无需重新解释上下文。

> **Harness identity stays native. Codex subscription is used through Codex itself.**
> **A native session only ever resumes on its own harness. A Handoff is an explicit action that carries the task into a new native session.**

* **Codex Local Runtime（`kind: codex`，仅本地执行）**：直接使用本机已安装的 `codex` CLI（`codex exec --json`），执行任务、捕获 thread id、解析事件（agent_message / reasoning / command_execution / file_change / mcp_tool_call / web_search / turn usage）、保存 `RuntimeSessionRef`（`runtimeKind=codex, nativeSessionRef=thread id, executionBackend=local, resumeSupported=true`），并用 `codex exec resume <id>` 原生续接。容器化在本阶段被明确拒绝。
* **Harness-native 认证（`credentialSource: "harness-native"`）**：Codex 使用自己的 ChatGPT 登录与套餐额度；AgentFabric 只通过 `codex --version` / `codex login status` 检测「已安装 / 已登录 / 可用」，**不读取、不复制、不保存**任何 access token / refresh token / auth 文件，也绝不把 Codex 登录转换成 AgentFabric Provider。未登录时 Run 快速失败并给出 `codex login` 修复指引。
* **不绑定 AgentFabric Model**：harness-native Runtime 不注入模型默认值（显式传入也会被忽略）——Codex 使用自己账号的默认模型；UI 上模型选择器替换为说明提示。
* **本地 Thread 发现与读取（官方接口）**：通过 `codex app-server` 的 JSON-RPC（`thread/list` / `thread/read` / `thread/turns/list`）发现本机已有 Codex Threads（按 cwd / 最近更新过滤，包含 cli / vscode / exec 三类来源），只读地取出用户输入、Agent 回复与 Tool Activity——**不解析 `~/.codex` 内部文件**，也绝不触发新的模型请求。
* **接管已有工作（Import / Adopt）**：`POST /api/harness/codex/threads/import` — Read Thread → 按 cwd 关联（或就地导入）Workspace → 每个 Codex turn 记录为一个已完成 Run（事件由 thread 内容投影）→ 注册 thread 为可 Resume 的 Native Session，且该 Native Session 引用会写在**每条**导入 Run 上（所有 turn 本就属于同一条原生会话，Runs 列表里每条导入 Run 都能复制 session id）→（可选）预生成指向目标 Harness 的 Handoff。不把 Codex Thread 转换成统一 Session。
* **已接管会话的显式同步（Sync，Codex 与 Claude Code 通用）**：接管是一次性快照；之后用户可能继续在原 Harness 里对话。`POST /api/tasks/:id/sync-thread` 重读原生会话，把新增的 turn 用与接管相同的投影路径**追加**为 Run（并写上同一条 Native Session 引用），同时更新 Task 上的 `threadUpdatedAt`。已入账的 turn = 接管/历次同步投影的 Run（`continuity: "new"`）+ 本任务在这条原生会话上 Resume 过的 Run（`continuity: "resume"`），因此不会把 AgentFabric 自己续跑的 turn 重复导入。同步会**解除**在此之前武装（`awaitingNextTurn`）的 Handoff——它基于过期快照生成，下一轮不该悄悄消费（`disarmedHandoffIds` 可见）。触发只有两个入口：该 REST 接口，以及 Task 页面的 Refresh 按钮（对已接管 Task 先同步再重读）；**没有后台轮询，也没有"有 N 个新 turn"之类的提示**。任务有进行中的 Run 时同步直接报错；非接管 Task 调用同步同样报错。
* **额度耗尽 UX（`errorKind: "usage-limit"`）**：识别 Codex 的配额错误（"You've hit your usage limit…"），Task 页面显示 **Codex usage limit reached.** 与 **Continue with Pi / Continue with OpenCode**，一键预选目标 Harness 并立即生成 Handoff，新 Harness 建立自己的新 Native Session 继续任务。

## Claude Code Local Harness（v7）

v7（`v7.md`）以同样的 harness-native 模式接入本机 **Claude Code CLI**，核心目标是：用户在 Claude Code 里做到一半（额度耗尽或主动切换），都能通过 AgentFabric 把任务自然交接给 Codex / Pi / OpenCode，并继续使用同一个 Workspace。

> **Claude Code subscription is used through Claude Code itself. AgentFabric must not turn Claude.ai subscription into an API Provider.**

* **Claude Code Local Runtime（`kind: claude-code`，仅本地执行）**：使用本机已安装的 `claude` CLI 非交互模式（`claude -p <prompt> --output-format stream-json --verbose`），执行任务、捕获 session id、解析事件（assistant text / thinking / tool_use→Bash·Edit·Write·Read…、tool_result、result usage）、保存 `RuntimeSessionRef`（`runtimeKind=claude-code, nativeSessionRef=session id, executionBackend=local, resumeSupported=true`），并用 `claude --resume <id> -p` 原生续接。容器化在本阶段被明确拒绝。
* **Harness-native 认证**：Claude Code 使用自己的 Claude.ai 登录与套餐；AgentFabric 只通过 `claude --version` / `claude auth status` 检测「已安装 / 已登录 / 可用」，**不读取、不复制、不保存**任何 credential / keychain / OAuth token，也绝不把 Claude.ai 套餐转换成 Anthropic Provider。未登录时 Run 快速失败并给出 `claude login` 修复指引。
* **不绑定 AgentFabric Model**：Claude Code 使用自己账号与默认模型配置；Usage / Cost 只采用 CLI 自报数字（`total_cost_usd`），绝不按 Anthropic API 定价估算套餐 Run 成本。
* **本地 Session 发现与读取**：Claude Code 官方只提供 `--resume <id>`（无 list 命令），因此发现走本地 transcript（`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`）——相关解析被严格限制在 Claude Code Adapter 内（`packages/runtimes`），不泄漏进 AgentFabric Core，且防御性处理未知行类型；读取不触发任何模型请求。
* **接管已有工作（Import / Adopt）**：`POST /api/harness/claude-code/threads/import` — Read Session → 按 cwd 关联（或就地导入）Workspace → 每个 session turn 记录为一个已完成 Run → 注册为可 Resume 的 Native Session（引用写在每条导入 Run 上，与 Codex 接管一致）→（可选）预生成 Handoff。
* **接管入口独立成页（Native sessions）**：Web UI 侧边栏 Resources 组的 **Native sessions**（`/sessions`）就是本地 Harness 会话的发现页——Codex Threads 与 Claude Code / ZCode / Pi / DSH Sessions 用页内 Tab 切换，可选 Workspace 过滤（默认全部，按最近更新排序），每个会话带 cwd / 更新时间 / turn 数 / 模型 / 来源与认证状态（检测，不读 credential），**Continue in AgentFabric** 读取该会话并进入 Task Thread。采纳前会先问工作目录归属：复用已有 Workspace / 用给定名字新建一条 / 不关联（会话 cwd 与某 Workspace 路径相同时默认复用）；AgentFabric 不会自己凭空建 Workspace 记录。New task 页面只负责描述新任务，底部给一行指向该页。
* **双向 Handoff**：Claude Code ↔ Codex / Pi / OpenCode 全部走既有 Handoff 流程（Claude Code → 其他 Harness 生成 Context Bundle：Checkpoint 覆盖装不下的历史，最近的用户指令与工作轨迹逐字保留；其他 Harness → Claude Code 注入 Handoff 后新建自己的 Native Session）。额度耗尽时 Task 页面显示 **Claude Code usage limit reached.** 与其他 Harness 的一键 Continue。
* **Runtime 状态**：Web UI Runtimes 页展示轻量状态（CLI Installed / Authenticated / Credential Source: Harness Native / Execution Backend: Local），不展示任何敏感 credential。

## Task 可用的 Runtime（usableInTask）

每个 Runtime 记录带 `usableInTask` 属性：**是否可作为 Task 的执行目标**。可用列表由后端给出——`GET /api/runtimes?usableInTask=true` 返回启用的、允许执行任务的 Runtime，New task 与 Task Thread 页面渲染这个列表（不自行派生）；服务端在 submit / continue 时做同一校验，目标 Runtime 不可用即拒绝（`code: "runtime-not-usable"`），所以前端过滤不可能被 API 绕过。接管（adopt）来的会话不受此限制、照常进入 Task（接管只投影历史、不执行模型），但继续执行时同样要过这道校验。

* **取值来源**：创建 Runtime 时按 kind 写入默认值（`pi` / `opencode` / `dsh` → `true`；`codex` / `claude-code` / `zcode` / `docker` / `mock` / `custom` → `false`），显式传入的值优先；Runtimes 页的创建表单同样可以指定。Runtimes 页每行提供 **allow / disallow in tasks** 切换，想用某个 kind 时翻开即可。表格只保留身份与状态列，点击任意一行弹出该 Runtime 的完整属性窗口（含同样的操作按钮）。
* **接管与执行的边界**：ZCode 这类只有探测器的 kind 默认不可用——接管其会话只收历史，composer 里继续时选的是可用 Runtime（跨 harness 走 Handoff）；绕过 UI 直接把任务提交到不可用 Runtime 会以 `runtime-not-usable` 明确失败，而不是等到 harness 启动才炸（没有运行适配器的 kind 仍会以 `No adapter registered for runtime kind "…"` 失败）。
* 种子写入的默认值在服务启动时一次性补齐到既有记录上；读取路径不派生、不修补该字段。

## ZCode / Pi / DSH 本地会话探测

在 Codex / Claude Code 之后，Native sessions 页面新增 **ZCode Sessions**、**Pi Sessions** 与 **DSH Sessions** 三个探测源：发现并读取本机已有的 ZCode、Pi、DSH（DeepSeek Harness）会话历史，接管后经 Handoff 交给其他 Harness 继续。只读，不触发任何模型请求。

* **临时目录约束（所有探测源通用）**：记录在临时目录下的会话——CI 步骤、一次性探针、测试夹具的产物——不是用户的工作，探测一律不列出。判定对所有 harness 用同一个谓词：cwd 等于或位于 `/tmp`、`/var/tmp`、系统临时目录（macOS 的 `/var/folders/…/T`）之下，字面与符号链接解析（`/tmp` → `/private/tmp`）两种形态都算；相对路径无法定位，不判为临时。约束只作用于发现列表，不删除任何会话数据。

* **ZCode 会话探测（`kind: zcode`）**：ZCode 没有列出历史会话的官方命令，发现直接读它的本地会话库 `~/.zcode/cli/db/db.sqlite`（SQLite，只读打开，仅触碰 `session` / `message` / `part` 三张会话表；credential 不会出现在其中）。只列主会话（`parent_id` 为空的分支子会话是内部簿记）；消息/部件按库内 `sequence` 列重建顺序；标题用 ZCode 自己生成的 `session.title`；`Bash` 工具调用投影为命令行活动，`Write` / `Edit` 系投影为文件活动，其余工具按通用工具调用投影；compaction 摘要作为 reasoning 条目保留在原位。
* **Pi 会话探测（`kind: pi` 的发现口）**：发现读 Pi 自己的 transcript（`~/.pi/agent/sessions/--<cwd>--/<时间戳>_<id>.jsonl`，可用 `AGENTFABRIC_PI_SESSIONS_DIR` 覆盖）——与 `pi --session` 恢复读的是同一批文件。首行 `{"type":"session",…}` 头是格式签名，无此头的 `.jsonl`（编辑器草稿等异质文件）直接跳过；transcript 条目经 `id`/`parentId` 组成树，只读活动分支（末条目沿 parent 链走到根），被放弃的分支不是对话；`session_info.name` 是标题（缺省回退首条用户输入），`model_change` 提供模型；`bash` 工具调用与其 `toolResult` 条目按 `toolCallId` 配对成命令行活动，compaction / branch 摘要投影为 reasoning 条目。
* **DSH 会话探测（`kind: dsh`）**：发现读 DSH 自己的会话事件日志（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`，可用 `AGENTFABRIC_DSH_SESSIONS_DIR` 覆盖）下 `<encoded-cwd>/<session-id>/session[.vN].jsonl[.zstd]`。**存储是全局一棵树：DSH 的所有 surface——Desktop / Web / headless——写这同一个会话库，探测天然覆盖全部来源，无需按 profile 合并**（本机实测 145 份日志里 143 份来自 Desktop/Web surface）。会话头记录 `agentPreset`——会话创建时所属的 surface 组成，可被会话中的 `agent-preset/selected` 事件改写；探测按 DSH 自己的算法（头预设 + 逐事件推进）重建出当前 preset，作为会话的 `source` 属性带出，headless 建的会话没有 preset。标题取最后一个非空 `session/title` 事件——DSH 先落一条首条提问截断的**占位标题**（`source.kind: "fallback"`），生成的标题随后改写它；列表因此读到生成标题出现为止（512KB 解压预算兜底，生成标题缺席的会话回退占位标题）。其余细节：`session` 头记录（id/cwd/createdAt）是格式签名；`.zstd` 日志是**逐次追加的拼接 zstd 帧**（DSH 每次落盘 flush 一帧，一个大会话有上万个帧）——Node 自带 zlib 解不了拼接帧、整份解压做列表又是秒级纯 JS 开销，探测器按帧头切分、逐帧解压（fzstd，纯 JS 零依赖）：列表只解到首个 turn 的标题与输入前缀（实测全库 144 份日志从 ~23s 降到 <0.5s），读取只整解目标会话那一份；`delegationDepth > 0` 的子代理会话不进列表（按 id 仍可读）。事件投影：`turn/start` 分轮，`user/message` 首条是轮输入（同轮后续注入消息投影为条目），`assistant/message` 的 reasoning / text 块投影为推理与回复，`tool/call` 与 `tool/result` 按 `callId` 配对（`bash` → 命令行活动，`edit` / `write` → 文件活动，其余 → 通用工具调用），`compaction/summary` 作为 reasoning 条目保留，流式 chunk 与 sandbox/approval/retry 状态不进对话。

### DSH Headless 运行适配器

DSH 官方 headless bundle（`@deepseek-ai/dsh-headless`）提供完整的无头运行契约，DSH Runtime 因此是**正式可执行目标**（`usableInTask` 默认 `true`）：

* **执行**：`dsh --profile headless --json [--session-id <id>] -- "<task>"`——一次调用跑一个任务，`--json` 在 stdout 投影 NDJSON 事件流（`session` → `status`（turn/step，`step_end` 携带该次模型请求的 usage）→ `text` / `thinking`（**已提交**的助手消息投影，重试中的尝试不会外泄）→ `tool_call` / `tool_result`（按 callId 配对）→ `final`），退出码 0 = 完成、1 = 中止/出错。事件映射与本地/容器化执行共用同一条路径（v3 §7）。
* **原生恢复与采纳边界（重要）**：`--session-id` 采纳 DSH 持久化的 Session——与本地探测列出的 id 同一套，跨 Run 的 continue 原生续在同一会话（DSH 自己维护 turn 计数）。但 headless 的组成里没有 agent preset，DSH 的采纳校验因此**拒绝一切带 preset 的会话**——即 Desktop / Web surface 建的全部会话（本机实测 145 份里 143 份）；同时也拒绝子代理/分叉会话，以及记录 cwd 与本次运行工作目录不一致的会话。这些校验全部由 DSH 自己在任务开始前强制执行，AgentFabric 原样透传其报错；探测带出的 `source` 属性就是该校验比对的那个 preset，可据此预判能否原生续跑。所以 DSH 会话的完整图景是：**Desktop/Web 会话——发现、读取、接管收历史，继续时走 Handoff 或其他 Runtime；只有 headless 自己建的会话能被 `--session-id` 原生续跑**。若 DSH 未来让 headless 组成与 Desktop 相同的 preset 或放宽该校验，适配器无需改动即可自动获益。
* **认证与凭据（harness-native，v6 §2）**：跑在 DSH 自己登录的 DeepSeek 账号上，不绑定 AgentFabric Provider/Model；可用性检测只看 `dsh --version`、headless profile 目录与 DSH 凭据文件的**存在性**，从不读取凭据内容。缺件时报错带补救命令（安装 CLI / `dsh plugin --profile headless add @deepseek-ai/dsh-headless` / 终端登录一次）。
* **边界**：DSH 没有官方运行镜像，容器化执行在未配置 `image` 时拒绝启动（原生状态挂载点 `/root/.dsh`）；没有 headless 侧的系统提示词 flag，Agent Profile 的系统指令以前置块拼进任务文本交付（与 Codex 同法）；Profile 级 `--patch` 自定义不受影响。

* **探测与运行的边界（重要）**：三者都做**发现 + 读取 + 接管**。Pi 会话接管后可以用既有 Pi 适配器原生 Resume；**只有 ZCode 还是探测器、没有运行适配器**——ZCode Runtime 默认 `usableInTask: false`，接管会话会把历史收进 AgentFabric Task，composer 里继续时选的是其他可用 Runtime（跨 harness 走 Handoff），不会误把 ZCode 当执行目标；绕过 UI 直接提交到 zcode 会以 `No adapter registered for runtime kind "zcode"` 明确失败。探测源挂在 Runtime kind 上：页面上没有已启用的对应 Runtime 时 Tab 提示去 Runtimes 页启用（ZCode / DSH Runtime 由种子默认创建）。
* **解析同样严格限定在 `packages/runtimes` 的适配器层**，不进入 Core；防御性处理损坏行（DSH 列表跳过解压失败的日志，读取同一份则明确报错）；读取不会执行任何模型请求。

## 长期任务执行模型（v1）

在 MVP 之上，v1（`v1.md`）建立了更稳定的长期任务执行模型：

> **Task 可以跨多个 Run 持续存在，Workspace 保存工作成果，同 Harness 使用 Native Resume，不同 Harness 通过 Handoff 完成交接，而 Runtime Container 根据执行需要动态创建和销毁。**

核心抽象：`Provider · Model · Runtime · Task · Run · Workspace · Handoff · Artifact`。
设计原则：Containers are disposable；Workspace is durable；Harness sessions stay native；**Resume 只在原生那把 Harness 内自动发生，跨会话必须由显式 Handoff 开启**；Workspace + Handoff 提供跨 Runtime 连续性；AgentFabric 只编排执行，不统一 Agent 认知。

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
* **Continue 的默认目标 runtime**：显式指定 > **最近一次 run 的 runtime** > task 创建时的默认 > 第一个启用的 runtime。中途换过 Harness 的 task，不带目标的「继续」落在**最近干活的 Harness** 上（比如中断后默认 resume 那个会话），而不是静默跳回 task 的初始 Harness——那会把一次普通继续包装成跨 Harness 交接请求。预览（`continue-options`）与实际决策（`pickTargetRuntime`）保持同一顺序。
* **Handoff**（跨 Harness 或无法 Resume）：生成语义化的工作交接（不迁移 Session，新 Harness 创建全新 Native Session），并以渲染后的 Handoff + 用户补充说明作为新 Run 的输入指令。
* **Handoff 不是摘要（Handoff ≠ Summary）**：目标不是「把旧 session 总结短一点」，而是**在目标 context budget 允许的范围内，最大限度重建上一个 Harness 的工作前沿**，让新 Harness 像接手进行中的工作一样继续。因此一次 Handoff 由五部分组成：**结构化 Checkpoint（历史状态索引）+ 历史用户上下文（逐字 pin）+ 最近工作轨迹（逐字保留）+ Current Frontier（最新状态）+ Workspace / metadata**。摘要只是「装不下的历史」的降级表示。
  * **Checkpoint 仍由模型写**（pi 原版的 Summarization System Prompt 与结构化模板：Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context），但只覆盖**没有被逐字带走的那部分历史**——`unretainedTurns()` 只把**完整保留**（或因为可重建而有意省略）的事件从摘要输入里剔除；**被 head+tail 截断过的 item 只算 partial，仍然留在 checkpoint 输入里**，否则被省略的中段就会既不保留、也不摘要，形成 information black hole（`v9.test.ts` T4/T5/T6）。同一段上下文绝不会既逐字保留又被摘要一遍。已有 Checkpoint 仍走 `<previous-summary>` 迭代更新；超长前缀按输入预算分块，每块的 Checkpoint 作为下一块的 `<previous-summary>`；read/modified 文件仍以 `<read-files>` / `<modified-files>` XML 累积（**ephemeral 临时路径**——`/tmp`、`/var/folders` 等——不进清单，仓库相对路径才保留）。**只取模型回答本身**：Responses API 的 `reasoning` 条目（`summary_text` / `reasoning_text`）与 OpenAI-compatible 的 `reasoning_content` / `reasoning` 内容块一律排除；`agent.thinking` 也不会进入逐字保留轨迹——迁移的是可观察的工作状态，不是模型的私有推理。Checkpoint prompt 要求 **Constraints 只写简短引用**（用户原话由 Preserved 段逐字携带，不整段复述），并声明它是**历史**状态索引。
  * **历史用户上下文逐字 pin**：原始任务与更早的用户指令（约束、偏好、需求变更、纠正、「不要做…」）不依赖模型转述——放得下就逐字保留；超出 pin 预算时至少保留原始任务，并从最近的用户轮次倒序补齐（`selectHandoffContext`）。已经出现在最近保留轨迹里的用户消息不会重复 pin。渲染正文明确告诉接收方：历史 user message **按时间顺序**排列，**后面的用户指令在与前面冲突时覆盖前面**；接收轮的**最新用户指令**按**位置权威**覆盖所有保留历史——正文不点名任何指令标题，只声明「在本 handoff 一切内容之后到达的指令优先」（AgentFabric 消费轮把它拼在正文之后的 `# Your instruction` 下，单独导出时就是新 Harness 输入框里的那句话）；没有被后续指令冲突的旧约束继续有效（`v9.test.ts` T15–T17）。
  * **最近工作轨迹逐字保留**：选择**从历史尾部向前**进行（最近的用户指令 > 最近的工具调用/结果 > 最近的助手结论）；预算耗尽时丢的是最老的部分，绝不会丢掉上一轮正在看的失败。保留以**原子单位**为单位：整条 user / assistant 消息、`tool call + 匹配的 tool result`、`shell.command + 其输出`——不会从任意字符偏移切一段。**tool call/result 配对永远 deterministic**：runtime 提供 native `toolCallId` / `callID` 时按 ID 配对；**没有 ID 时**按「工具名 + 目标参数（path/command/query）」匹配到对应的 pending call，无法区分时取最早发出、尚未配对的那个——`read a.ts` / `read b.ts` 会各自配到自己的结果，结果乱序到达也不会串配，更不会因为同名就合并成一个 identity 或补出一个 synthetic call。
  * **Tool result 的两种表示彻底分开**：`SUMMARY_TOOL_RESULT_MAX_CHARS`（2000，pi 的上限）只用于**摘要表示**（喂给 Checkpoint 模型），且该上限也改为 **head+tail**（历史 turn 的结尾往往就是结论/最终失败，不能因为从头截断而永远丢失）；**保留表示**在预算足够时逐字保存——例如 18K 字符的测试输出会完整保留，不截成 2K。单个交互超出剩余预算时按**尾部优先的 head+tail**（20% head / 80% tail）并带标记 `[... N characters omitted from the middle during handoff retention ...]`：测试/编译器/构建的失败、堆栈、退出码都在结尾，那才是执行前沿。整段历史**不做从头截断**来决定保留内容。
  * **每个保留的 tool call 都有显式结局语义**：完成且有文本 → 正常 `[Tool result]`；完成但**无文本 payload** → `[Tool result status]: completed — no textual result payload was captured`；**源事件里根本没有 result**（completion 未到达）→ `[Tool result status]: result unavailable in the normalized source events`；**失败** → `[Tool result]: FAILED — <错误原文>`；**可重建而有意省略** → 明确的 reconstructable 标记。五种状态互不混淆，孤儿 call 不会被误读成成功，也永远不伪造输出。
  * **本地大 mutation 语义投影**：`edit` / `write` / `apply_patch` 等**成功**落地到 shared workspace 的大体积调用（oldText/newText/正文超过阈值）不整段搬运——保留「工具 + 目标路径 + 操作语义」并注明 `final file state is reconstructable from the shared workspace`（最终文件可重读，历史 diff 正文是可重放数据）。**失败**的 mutation 不做这种省略：保留目标与 body 头部 + 完整错误（失败上下文无法从最终 workspace 重建）。shell 命令、测试命令、查询、git 命令等高保真参数**永不**投影。
  * **可重建 vs 不可重建**：本地文件读取（`read(path=…)`、`cat src/foo.ts`、`git diff` 等只读命令）在 shared workspace 仍在时可由新 Harness 自己重新获取，因此大体积文件正文不占 handoff 预算——保留 `tool call` 与明确标记（`[Tool result omitted … Re-read src/foo.ts if it matters.]`），**不伪造旧文件内容**；**ephemeral 路径**（`/tmp`、`/var/folders` 等临时目录）不算可重建——新 Harness 读不回来，「重读即可」就是假承诺。测试/编译输出、Web/API 响应、远程查询、subagent 结果等一次性观测在同等预算下优先保留。checkpoint 的 `<read-files>` / `<modified-files>` 文件清单从 tool event 的顶层字段**或** tool 输入参数（OpenCode / pi 的 `input.path`）中提取，因此「看过哪些文件」不会因为运行时字段位置不同而丢失。
  * **两个预算彻底分开**：**Handoff 总预算** = `min(configuredMaxHandoffTokens, floor(targetContextWindow × handoffContextRatio))`，默认 `150_000` / `0.15`：1M 窗口 → 150K、512K → 76.8K、256K → 38.4K、128K → 19.2K。**Checkpoint 预算**独立且很小，默认 `checkpointMaxTokens = 12_000`（且不超过摘要模型窗口的一半与模型 `maxTokens`）。**150K 是 Handoff 上下文总量，不是摘要输出大小**——把 150K 当 summary `max_output_tokens` 是要明确避免的失败模式（`v8.test.ts` T3 有防回归测试）。**150K 是上限不是配额**：有价值上下文只有 8K 就发 8K，不为凑数塞入可重建大 diff、重复摘要或计费元数据（`v10.test.ts` T24）。**目标窗口解析顺序明确**：显式 target/runtime capability（`runtime.contextWindow` / `runtime.capabilities.contextWindow` / `runtime.config.contextWindow`）> 已配置的 AgentFabric model `contextWindow` > 安全默认 `128_000`（`DEFAULT_TARGET_CONTEXT_WINDOW`）——因此 Codex / Claude Code / Pi / OpenCode 这类 harness-native 目标只要声明了真实窗口，就不会永远退化到 128K → 19.2K；**绝不按模型名猜测、绝不联网查询**；解析结果连同**来源**（`contextWindowSource`：`runtime-capability` / `configured-model` / `default`）一起记进预算账目。**Token 估算只有一个入口**（`estimateTextTokens` / `handoffTextCost`）：拉丁/代码/日志用 `charsPerToken = 2`，CJK（汉字、假名、谚文、全角）按**每字符至少 1 token** 计入，宁可保守（估算偏大）也不让中文上下文系统性超出目标预算。Bundle 记录 `contextWindow / contextWindowSource / maxTokens / estimatedTokens / checkpointTokens / pinnedTokens / retainedTokens / frontierTokens / metadataTokens / userNotesTokens / charsPerToken`。
  * **预算账目覆盖真正渲染的每个 section**：checkpoint、frontier、pinned、retained、workspace/run metadata、渲染脚手架、以及 **user notes** 都计入 `estimatedTokens`；`userNotes` 会先从总预算里预留，选择器据此腾空间，不会出现「报告 145K、实际渲染 245K」。若单是 user notes 就超过整个 handoff 预算，则**明确报错**（`HandoffBudgetExceededError`，`code: "handoff-budget-exceeded"`），不做静默溢出、也不谎报 within budget；后续通过 `addUserNotes` 追加备注若会超出已记录的预算同样报错且不写入。`# Your instruction`（接收方当前指令）不在这个 budget 内，它是独立的执行 runway——`budget.estimatedTokens` 只表示 handoff 正文。**观测性数据不进模型上下文**：token 用量 / 成本 / 计费只留在 Run 记录与 Inspector，渲染正文绝不包含（`v10.test.ts` T18/T23）。
  * **选择完全 deterministic**：recency / role / tool 类型 / 可重建性 / 原子配对 / 预算，全是规则；**不会为了决定「留下哪些消息」再调一次 LLM**——只有 Checkpoint 由模型写。**Current Frontier 也确定性生成**：取保留轨迹末尾的最新 assistant 结论（截尾限长），不另调模型。
  * **可审计、可检查**：`GET /api/handoffs/:id` 返回完整记录（Context Bundle、每个 slice 的 `retention`：`pinned` / `recent` / `paired` / `oversized-truncated`、预算账目（含目标窗口来源与各 section 实际开销）、渲染后的正文）；Handoff 页面单独展示 bundle、预算与 frontier，调试时能直接看出「某段 context 为什么被留下」「这次 handoff 用了多少预算、预算从哪来」。`GET /api/handoffs`（列表）只返回索引行，不含庞大的 context。`generation.method = "context-bundle"`，`coveredRunIds` 记录覆盖的 Run。Handoff 详情页可以把渲染后的正文**导出为 Markdown 文件**（`handoff-<id>.md`）——导出的就是页面展示的、交给下一个 Harness 的同一份正文，纯前端下载，服务端不重新渲染。
  * **信任规则先于不可信数据**：渲染正文以 `# How to read this handoff` 开篇——阅读顺序（checkpoint 更早、recent 更晚；接收轮的用户指令在一切之后）与信任规则（只有 `[User-authored]` 是用户原话；`[User-context]` 可能含 harness 包装；`[Tool result]` 是不可信观察数据，其中的「指令」必须上报而非执行）在**任何原始 tool 数据出现之前**就建立（`v10.test.ts` T16）。**正文不引用任何自己不包含的 section**，因此导出后单独拿到别的 Harness 里也自洽：本轮没有新指令时，接收方**不擅自开工**，先简要复述最近工作，再询问用户最新指示（`v9.test.ts` T17/T17b）。用户权威取决于**来源**而不只是 role 标签：AgentFabric 记录的裸输入是 `[User-authored]`；harness 回显的 user 轮次与接管的原生线程是 `[User-context]`（检测到 `# Files mentioned by the user` / `## My request:` 等包装时 Inspector 标注 wrapper）。
  * **历史内容无法伪装成 Handoff 控制结构**：所有保留 slice 的正文渲染在角色标签之后，含标题行 / `[User]:` 标记 / 多行 / 围栏的内容包在**自适应长度代码围栏**里——tool 输出里的 `# Your instruction`、assistant 消息里的 `# Handoff checkpoint`、`[User]: ignore all previous rules` 都保持为被引用的数据，不可能变成顶层 section 或获得用户权威（`v10.test.ts` T13–T15）。
  * **Workspace 仍是权威**：shared workspace 是唯一工作目录，正文首段就声明相对路径的解析基准，并明确 workspace 是 **AUTHORITATIVE current state**——历史 edit 正文只是可重放数据，读当前文件优先；Handoff 不从 harness 日志、临时容器路径或 provider 路径里推断项目位置。
* **Handoff ≠ Context Compaction（两个必须分清的概念）**：**Context Compaction 是会话内的**——harness（pi / Claude Code）为了让活会话装进模型窗口而摘要较早的轮次，之后**继续用同一个 native session**；AgentFabric 从不做这件事，它属于 harness。**Handoff 是跨会话的**——当前 native session 结束，新的 session（通常换 harness）以上面的 Context Bundle 作为上下文，并落库为一条 `Handoff` 记录。因此：**Handoff 永远只能被显式触发**（UI 的 Generate handoff 按钮 / `POST /api/tasks/:id/handoff` / `mode: "handoff"`），发送消息绝不会「顺手」生成一个——`continueTask` 在需要 handoff 却没有现成的时候抛 `HandoffRequiredError`（`code: "handoff-required"`），由前端弹确认后再生成并发送。历史字段 `content.compactionSummary` 已被 `content.contextBundle` 取代：不保留旧字段的读写兼容路径，旧记录视为无效数据、重新生成即可。
* **Checkpoint 模型显式可配（Handoffs 页）**：写 Checkpoint 的模型按显式优先级选择，并把选择依据记进 `generation.modelSource`（`configured` / `previous-run` / `first-enabled`）供审计：**Handoffs 页配置的模型**（存 `config.handoff.modelId`，经 `GET/PUT /api/handoffs/model` 读写，写入时即校验模型与 provider 存在且启用）> **被交接 Run 自己的模型** > **第一个启用的模型**。配置的模型一旦失效（模型或 provider 被删/停用），生成**响亮失败**、绝不静默换一个模型：严格调用方直接报 `handoff-unavailable`，只有显式确认降级的才落 heuristic 摘要且 `detail` 注明原因；Handoffs 页的配置卡同时就地提示「配置的模型不可用」。与目标窗口解析同一条纪律：**不按模型名猜测、不联网查询**。整段历史逐字放下而不需要 Checkpoint 时，不调任何模型，记录上也不归属模型。
* **Handoff 生成失败不再静默降级**：Checkpoint 模型不可用（未配置 provider/model、调用失败、失败检查不通过、回答不是 Checkpoint——没有 `## Goal` 标题）时，默认**报错**并携带 `code: "handoff-unavailable"`——显式 Handoff 请求（`POST /api/tasks/:id/handoff`、`mode: "handoff"`）直接失败；隐式跨 Harness 继续返回 409，由前端向用户说明原因后，**只有用户显式确认**才以 `allowDegradedHandoff: true` 继续。此时产出结构化摘要（任务 / 文件变更 / 工具 / 末条消息），并在 `handoff.generation.method = "heuristic"` 上标注为**降级**，UI 显著提示「非模型 Checkpoint」——降级永远可见、永不冒充。若覆盖范围内**没有任何**需要摘要的历史（整段历史都在总预算内逐字保留），则不调用模型、也不产生 Checkpoint：`method` 仍是 `"context-bundle"`，轨迹本身就是交接内容。Thread Adoption 属系统路径，自动带 `allowDegraded: true` 以保证接管不被阻塞。
* **生成可取消、总时长有上界**：整次 handoff 生成（含分块与重试）受总预算约束（`HANDOFF_GENERATION_BUDGET_MS`，默认 10 分钟；单次调用另有 4 分钟安全上限——为慢推理 summarizer 留出余量，总预算保持在单次上限的两倍以上，使单 chunk 生成实际受单次上限约束），超预算即中止并进入上面的失败策略；同时把调用方的 `AbortSignal` 一路透传到模型调用与重试退避——HTTP 客户端断开、或点 Handoff 生成弹层的 Cancel，都会**真正停止服务端工作**，而不是只停止等待。被取消的请求永远按取消处理，不会落成降级 handoff。
* **Runtime Capability**：adapter 声明 `supportsNativeSession / supportsNativeResume / supportsStreamingEvents / supportsHandoffGeneration / supportsWorkspace / supportsInteractiveExecution`，并可通过 `containerizedCapabilities` 按执行后端收窄——声明的能力必须在当前 Execution Backend 下真实可用；AgentFabric 据此决定 Resume 或 Handoff，`GET /api/tasks/:id/continue-options` 让用户在执行前明确看到即将发生的是 Resume 还是 Handoff。Runtime 还可声明 `contextWindow`（或 `capabilities.contextWindow` / `config.contextWindow`），作为 handoff 预算解析的**显式 target capability**。

### Handoff 加固（v9）

v9 没有改动 Context Bundle 架构（仍是 checkpoint + pinned + retained），只修 correctness / budget accuracy / target capability / instruction semantics：

* **无 native call ID 的 tool 配对**：不能再拿 tool name 当唯一 identity；同名调用按目标参数匹配、按发出顺序兜底，且不产生 synthetic 重复 call（`v9.test.ts` T1–T3）。
* **partial retention ≠ fully covered**：head+tail 截断过的 item 标记为 `partial`，其事件仍进入 checkpoint 输入，中段不会消失（T4）；完整保留的 item 不会被重复摘要（T5）；可重建内容仍可整段排除（T6）。
* **target capability 驱动预算**：`runtime.contextWindow` / `capabilities.contextWindow` / `config.contextWindow` > 已配置 model window > 默认 128K；harness-native 目标声明 1M 即得 150K（T7–T9）。
* **预算账目完整**：user notes 计入预算并让选择器腾空间；notes 本身超预算则明确报错（T10/T11/T20）。
* **多语言估算保守**：CJK 每字符至少 1 token，中文上下文不会按拉丁 2 chars/token 低估（T12–T14）。
* **历史指令优先级明确**：user message 按时间顺序，后者覆盖冲突的前者，当前 instruction 最新（T15–T17）。
* **超长历史保留尾部**：摘要输入与摘要 tool result 上限都改为 head+tail，旧的「只保留开头」不再存在（T18/T19）。

回归验证见 `packages/core/src/v9.test.ts`（含 one-shot 语义 fixture 与「小任务不强行摘要」的回归用例）。

### Handoff 上下文质量与语义（v10）

v10 不改 Context Bundle 架构（仍是 checkpoint + pinned + retained），解决真实 Handoff 样本暴露的**时间语义 / 来源权威 / 信息密度 / 工具交互完整性 / 序列化边界 / 观测性分离**问题。渲染正文结构变为：

```text
# How to read this handoff     阅读顺序 + 信任规则（先于一切不可信数据）
# Workspace                    权威工作目录（AUTHORITATIVE current state）
# Historical checkpoint        历史状态索引——明确早于 recent context
# Preserved user instructions  逐字保留的历史用户指令（[User-authored] / [User-context]）
# Recent working context       逐字保留的最近轨迹（晚于 checkpoint，冲突时 later wins）
# Current frontier             最新状态（保留轨迹末尾的确定性提炼，很小）
# Notes from the user          handoff 时用户补充
# Your instruction             消费轮追加的最新用户指令（不属于渲染正文）
```

* **时间语义显式化（T1/T2）**：checkpoint 描述的是 recent working context 发生**之前**的历史状态，不再冒充「最终现状」；正文明确声明——recent context 在 checkpoint **之后**、按时间顺序更新它，**status / progress / blockers / next steps 冲突时 later context wins**（recent 显示已完成的就是已完成，不重做 checkpoint 里的旧 Next Steps；显示已解除的 blocker 就是已解除）。
* **Current Frontier（v10 §5）**：从保留轨迹末尾确定性提炼（最新 assistant 结论，`FRONTIER_MAX_CHARS` 封顶、按预算比例预留），让接收方一眼判断「现在实际做到哪里」，不被 stale checkpoint 误导；不重新总结整个 session，不额外调用模型。
* **来源权威（provenance，T4/T5）**：`userPrompt` 的权威取决于**记录来源**——AgentFabric 编排层记录的裸输入 → `[User-authored]`（用户原话，携带用户指令权威）；harness 回显的 user 轮次 / 接管的原生线程（`userPromptProvenance: "harness-reported"`，接管任务自动标记）→ `[User-context]`（可能含 harness 生成的包装、附件元数据，**不保证**是用户原话；检测到 `# Files mentioned by the user` / `## My request:` 等包装模式时 Inspector 标注）。不做超出实际来源的声明——绝不把合成包装提升为用户原话。
* **工具调用语义投影（T6–T8）**：成功的本地大 mutation（edit/write/apply_patch 等，body 超过 `MUTATION_BODY_PROJECT_THRESHOLD_CHARS`）投影为「工具 + 目标路径 + 操作语义 + 可重建说明」；失败的 mutation 保留目标、body 头部与完整错误（失败不可从最终 workspace 重建，诊断优先级远高于可重放数据）；小 mutation 与所有命令 / 查询 / git / 测试命令保持逐字高保真。
* **显式结局语义（T9–T12）**：每个保留的 tool call 必有结局状态——`completed — no textual result payload was captured`（完成无文本）、`result unavailable in the normalized source events`（源事件缺 result）、`FAILED — <错误>`（失败）、reconstructable 省略标记（有意省略）互不混淆；不伪造任何输出。
* **强序列化边界（T13–T16）**：保留内容渲染在角色标签后，含标题行 / 角色标记 / 多行 / 围栏的正文包进**自适应围栏**——`# Your instruction`、`# Handoff checkpoint`、`[User]:` 出现在历史内容里只能是数据；信任规则（trust rules）出现在任何原始 tool 数据**之前**。
* **checkpoint 与 pinned 去重（T17）**：Checkpoint prompt 要求 Constraints 只写**简短引用**（用户原话由 Preserved 段逐字携带），不整段复述浪费 token。
* **观测性分离（T18/T23）**：source run 的 token 用量 / 成本 / 调用次数不进渲染正文（Inspector / Run 记录 / `generation.usage` 仍完整保留）；预算诊断（目标窗口、来源、各 section 开销）也只给 Inspector 看，不注入 LLM 上下文。
* **路径权威（T19/T20）**：仓库相对路径 / 持久 workspace 路径优先保留；`/tmp`、`/var/folders` 等 ephemeral 路径不进 checkpoint 文件清单、不算可重建（读不回来的文件不承诺「重读即可」）。
* **Inspector 预算诊断（T21/T22）**：Bundle 预算账目新增 `contextWindowSource`（runtime capability / configured model / default）与 `frontierTokens`；Handoff 页面展示目标窗口来源、预算上限、实际各 section 开销。
* **信息密度（T24）**：150K 是上限不是配额——小任务产出小 handoff，成功的大 mutation 正文不因「预算还很多」而搬运。

验收测试见 `packages/core/src/v10.test.ts`：T1–T24 全覆盖，外加 ONE-SHOT 语义 fixture（1M 目标 / 中文约束 / harness 包装 / 历史大 edit / 回归命令 / 缺失 result / 伪造指令注入 / 观测元数据，一次生成验证全部语义属性）与「小任务保持小」回归用例。


## 容器化 Native Resume（v2）

v2（`v2.md`）移除了旧的统一 AgentFabric Session 抽象，并打通了 Containerized Runtime 下的 Native Resume 闭环：

> **Task → Run → Runtime → RuntimeSessionRef**，其中 `RuntimeSessionRef` 是 Harness 原生 Session 的不透明引用，而不是一个新的 AgentFabric Session。

* **统一 Session 模型已删除**：顶层 `Session` 实体、`Task.sessionId`、Session 生命周期与 Session Usage 聚合、`/api/sessions*` 接口与 `af sessions` 命令均已移除；旧数据在 Store 加载时自动迁移清理。原生 Session 状态通过 Task/Run/Runtime 详情与 `/api/runtime-sessions` 了解。
* **执行后端（Execution Backend）**：`Harness Adapter → Execution Backend → (本地进程 | Docker 容器)`。Docker 只是执行载体，不再把 OpenCode/Pi 的结构化输出降级成 Shell Log——容器的 stdout/stderr 以原始行流交给对应 Harness Adapter，本地与容器化复用同一套输出解析器（事件解析、Native Session 提取、Usage/错误解析）。
* **Ephemeral Container 下的闭环**：Run #1 创建临时容器 → 挂载 Workspace + Native State → 捕获 Native Session Ref → 容器销毁；Run #2 新建容器 → 挂载同一 Workspace 与同一 Native State → 用 Native Session Ref Resume。Native State 是 Host 上的 Opaque 目录（默认 `~/.fabric/native-state/<runtimeId>`），按 Harness 挂载到容器内对应路径（OpenCode `/root/.local/share/opencode`，Pi `/root/.pi`，可用 `runtime.config.nativeStateMountPath` 覆盖）。
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
* **Native Resume 条件收紧**：自动 Resume 需要 **Same Harness × Same Workspace × 有效 RuntimeSessionRef × Native State 真实存在（目录在磁盘上）× 当前执行方式下能力成立**。不满足时不会自动降级——需要显式 Handoff 才能开新 Session（不同 Workspace、本地与容器化会话都不互串）；判定集中在一个可扩展的 Resume Gate，为未来（Runtime/Harness/Native State 版本、模型等维度）预留空间。
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
| GET | `/api/tasks/:id/continue-options` | Resume vs Handoff 决策预览（不生成内容） |
| POST | `/api/tasks/:id/continue` | 继续任务（自动/强制 Resume 或 Handoff）；Checkpoint 生成失败时返回 409 `handoff-unavailable`，带 `allowDegradedHandoff: true` 可显式降级 |
| POST | `/api/tasks/:id/sync-thread` | 重读已接管 Task 的原生会话，把接管（或上次同步）之后发生在 Harness 里的新 turn 追加为 Run（显式触发，无后台轮询） |
| GET | `/api/handoffs?taskId=&runId=` | Handoff 索引列表（id / 来源 / generation / 覆盖的 Run；不含 context bundle） |
| GET | `/api/handoffs/:id` | Handoff 完整记录（Context Bundle、每个 slice 的 retention、预算账目、渲染正文、被哪些 Run 消费） |
| POST | `/api/handoffs/:id/notes` | 追加用户说明 |
| GET/PUT | `/api/handoffs/model` | 读/写 Handoff Checkpoint 模型（`config.handoff.modelId`；`modelId: null` 恢复自动选择；写入校验模型与 provider 存在且启用） |
| GET | `/api/runtime-sessions` `/api/runtime-sessions/:id` | 原生 Session 引用 |
| POST | `/api/runtime-sessions/:id/expire` | 标记引用失效 |
| GET/DELETE | `/api/native-states` `/api/native-states/:id` | Runtime Native State（v2） |
| POST | `/api/workspaces/import` `/api/workspaces/:id/save` | Workspace 导入 / 保存 |
| GET | `/api/workspaces/:id/usage` | Workspace 被哪些 Task/Run 引用 |
| GET | `/api/runtimes/:id/capabilities` | 生效的 Harness 能力 |
| GET | `/api/containers/kept` | keep-alive 保留中的容器 |

### CLI

```bash
# 数据目录默认 ~/.fabric，可用 AGENTFABRIC_DATA_DIR 覆盖；API 地址默认 http://localhost:7377

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
af artifacts list --run <run-id>
af artifacts get <artifact-id> --output report.md
af usage  # 或 af config / af secrets / af tasks
```

## API 概览

所有资源均为 REST JSON，实时事件用 SSE：

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/dashboard` | 统计 + Usage（Recent runs 已移除，任务/Run 列表看 Tasks 与 Runs 页） |
| CRUD | `/api/providers` `/api/models` `/api/runtimes` `/api/workspaces` `/api/secrets` `/api/agents` | 各资源管理 |
| POST | `/api/runtimes/:id/enable` `/disable` | 启用/禁用 |
| GET/POST | `/api/tasks` | Task |
| POST | `/api/runs` | 提交 Task 并创建 Run（异步执行） |
| GET | `/api/runs` `/api/runs/:id` | 查询 Run |
| POST | `/api/runs/:id/cancel` | 取消 |
| GET | `/api/runs/:id/events` `/logs` | 事件 / 日志 |
| GET | `/api/runs/:id/events/stream` | **SSE**：单 Run 实时事件流 |
| GET | `/api/events/stream` | **SSE**：全局事件流 |
| GET | `/api/runtime-sessions` `/api/native-states` | 原生 Session 引用 / Native State |
| GET | `/api/harness/:kind/auth-status` | Harness-native 登录状态检测（v6，仅检测不碰凭据） |
| GET | `/api/harness/:kind/threads` | 本地 Harness Thread 发现（`?cwd=` / `?workspaceId=` / `?limit=`） |
| GET | `/api/harness/:kind/threads/:threadId` | 只读读取已有 Thread 内容 |
| POST | `/api/harness/:kind/threads/import` | 接管已有 Thread → Task + Handoff |
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

* 数据保存在 `~/.fabric/db.json`（可用 `AGENTFABRIC_DATA_DIR` 覆盖到任意目录），原子写入。
* Run 事件不进 db.json：事件负载按 run 分片，append-only 追加到 `~/.fabric/events/<runId>.jsonl`；db.json 只保留每 run 一行的索引（`eventShards`：文件、条数、字节数、`lastSeq` 高水位，`lastSeq` 同时用于重启后恢复全局 seq 计数器）。读取按需从分片文件载入。
* `git` 类型 Workspace 在创建时克隆到 `AGENTFABRIC_DATA_DIR/workspaces/<id>`，Run 时挂载真实目录。
* Secrets 值仅在创建时返回一次，其余接口返回掩码；Secrets 不进入日志与事件；按 `secretIds` 注入 Runtime 环境变量。
* API Key 通过 `Provider.apiKeySecretId` 引用 Secret，Provider 记录中只有掩码。
* Execution Policy 会在 Run 中强制执行：`maxDurationMs` 超时、`maxModelCalls` / `maxTokens` / `maxCost` 超限即中止 Run（failed）；`cpu` / `memory` 传给容器；`network.enabled=false` 时容器 `--network none`。

## 已知边界（MVP）

* 成本为内置价格表的估算值，可通过未来定价 API 覆盖。
* 持久化使用 JSON 文件，适合单机 MVP；生产可替换为数据库。
* OpenCode / Pi 本地适配器依赖本机已安装的 CLI（`AGENTFABRIC_OPENCODE_BIN` / `AGENTFABRIC_PI_BIN` 可覆盖）。
* ZCode 只有本地会话探测（读 `~/.zcode/cli/db/db.sqlite`），没有运行适配器——接管后继续执行会明确报错，跨 Harness 用 Handoff。DSH 有官方 headless 运行适配器（读 `$DSH_HOME/sessions` 做发现），但没有官方容器镜像，容器化执行需自备镜像。
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
