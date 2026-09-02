# AgentFabric

> **Run any agent, on any model, in any environment.**

AgentFabric 是一个开源 Agent Runtime Orchestration 平台。它不定义 Agent 应该如何思考，而是提供统一的基础设施来管理 **LLM Provider、Model、Agent Runtime、Workspace、Task、Run、Session、Artifacts 与 Observability**。

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
                        │  Session · Event · Artifact     │
                        │  Secret · Profile · Usage/Cost  │
                        │  Orchestrator (Run lifecycle)   │
                        └───────┬─────────────────────────┘
                                │ Runtime Adapter Protocol (RuntimeRegistry)
                  ┌─────────────┼──────────────┬──────────────┐
                  ▼             ▼              ▼              ▼
             OpenCode       Pi Agent        Docker        Mock
             Adapter        Adapter         Adapter        Adapter
             (本地 CLI)     (本地 CLI)      (容器)         (模拟)
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
| Session | 创建/恢复/查看/继续提交，无状态一次性 Run 也支持 |
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

打开 http://localhost:7377 查看 Web UI（Dashboard / Runs / Run Detail 实时事件流 / Providers / Models / Runtimes / Agents / Workspaces / Sessions / Artifacts / Usage / Settings）。

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

# 指定 Runtime / Model / Workspace / Session / 超时
af run "给 README 补充用法" --runtime <rt> --model <model> --workspace <ws> --timeout 600000
af run "继续上次讨论" --session <session-id> --follow

# Runs / Sessions / Artifacts / Usage
af runs list
af runs show <run-id> --follow
af runs logs <run-id>
af runs cancel <run-id>
af runs rerun <run-id>
af sessions create --name my-session
af sessions resume <session-id> "下一步做什么"
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
| CRUD | `/api/sessions`；POST `/api/sessions/:id/resume` `/close` | Session |
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
* 容器化 OpenCode / Pi 需要包含对应 CLI 的镜像（`runtime.image`）。
* Network `allowedHosts/blockedHosts` 与 Filesystem `allowedPaths/deniedPaths` 暂未做细粒度强制（仅支持整体开关与只读挂载）。

## 测试

```bash
npm test          # core 单元测试（store/secret/mock run/cost/event bus/policy/git workspace）
```
