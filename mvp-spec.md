# AgentFabric 项目需求

请帮我设计并实现一个名为 **AgentFabric** 的开源 Agent Runtime Orchestration 平台。

AgentFabric 的核心定位是：

> **Run any agent, on any model, in any environment.**

AgentFabric 不负责定义 Agent 应该如何思考，而是提供统一的基础设施，用于管理 **LLM Provider、Model、Agent Runtime、Workspace、Task、Run、Session、Artifacts 和 Observability**。

用户可以自由选择模型 Provider、模型和 Agent Runtime，并通过隔离的容器环境执行 Agent Task。

## 1. Provider 管理

支持用户配置和管理不同的 LLM Provider。

需要具备：

* 添加、编辑、删除 Provider
* 支持自定义 API Endpoint / Base URL
* 支持 API Key 等认证信息
* 支持 OpenAI-compatible Provider
* 为不同 Agent Runtime 提供统一的 Provider 配置方式
* Provider 配置中的敏感信息需要通过 Secrets 管理

初期可以优先支持主流 Provider，同时允许用户接入自定义 Provider。

## 2. Model 管理

在 Provider 之上提供统一的 Model 抽象。

用户可以：

* 添加和删除 Model
* 指定 Model 所属 Provider
* 配置 Model Name / Model ID
* 配置模型相关参数
* 为 Model 设置便于引用的 Alias
* 在运行 Task 时自由选择 Model

Runtime 不应该强依赖具体 Provider，而是通过 AgentFabric 的 Model 配置获得所需要的模型信息。

未来可以扩展 Model Routing、Fallback、成本控制和负载均衡能力。

## 3. Agent Runtime 管理

Agent Runtime 是 AgentFabric 的核心能力之一。

一个 Runtime 代表一种可以执行 Agent Task 的 Agent 环境。

初期至少支持：

* OpenCode Runtime
* Pi Agent Runtime

每个 Runtime 原则上运行于独立 Docker 容器中。

用户可以：

* 查看可用 Runtime
* 添加 Runtime
* 配置 Runtime
* 启用或禁用 Runtime
* 为一次 Run 指定 Runtime
* 使用自定义 Runtime Image

AgentFabric 应建立统一的 Runtime Adapter / Runtime Protocol，使未来能够接入更多 Runtime，而不需要修改核心系统。

未来可能支持其他 Coding Agent、CLI Agent 或自定义 Agent Runtime。

## 4. Container / Sandbox

Agent Runtime 默认运行在隔离的容器环境中。

需要支持：

* 创建和销毁 Runtime Container
* CPU / Memory 等资源限制
* Workspace 挂载
* 环境变量注入
* Secrets 注入
* 网络访问策略
* 文件系统访问控制
* Runtime 生命周期管理
* Task 超时
* Container 状态管理

需要同时考虑：

* Ephemeral Runtime：Task 完成后销毁
* Persistent Runtime：Task 完成后保留 Runtime / Session

## 5. Workspace

Workspace 表示 Agent 执行 Task 时可以访问的工作目录和项目环境。

支持：

* 本地目录
* Git Repository
* Volume / Directory Mount
* Workspace 持久化
* Workspace 与 Run 关联

对于 Coding Agent，Workspace 通常对应一个代码仓库。

Agent 可以在 Workspace 内读取文件、修改代码、执行命令并产生新的文件。

## 6. Task

Task 表示用户希望 Agent 完成的目标。

例如：

“分析当前代码库并修复所有 failing tests。”

Task 可以指定：

* Runtime
* Model
* Workspace
* Environment
* Tools
* Secrets
* Resource Limits
* Timeout
* Execution Policy

Task 提交后，由 AgentFabric 创建对应的 Run。

## 7. Run

Run 是 AgentFabric 最核心的运行时资源。

每一次 Task 执行都应该产生一个独立 Run。

Run 需要记录：

* Task
* Runtime
* Model
* Provider
* Workspace
* Container
* Session
* Status
* Start Time
* End Time
* Logs
* Events
* Token Usage
* Model Usage
* Cost
* Artifacts
* Error

Run 至少支持以下生命周期：

* Pending
* Starting
* Running
* Completed
* Failed
* Cancelled
* Timeout

用户应该能够查看、取消、重新执行和检查历史 Run。

## 8. Session

支持 Runtime Session。

Session 用于保存 Agent 的连续执行上下文，使用户能够在一次 Run 完成后继续与 Agent 交互。

支持：

* 创建 Session
* 恢复 Session
* 查看 Session
* 在已有 Session 上继续提交 Task
* Session 与 Runtime / Workspace 关联
* Session 生命周期管理

同时允许无状态的一次性 Run。

## 9. Events & Logs

建立统一的 Agent Runtime Event 系统。

不同 Runtime 应尽可能转换为 AgentFabric 的标准事件。

事件可以包括：

* Run Started
* Run Completed
* Run Failed
* Agent Message
* Model Request
* Model Response
* Tool Started
* Tool Completed
* Shell Command
* Shell Output
* File Created
* File Modified
* Artifact Created
* Runtime Error

用户应该能够实时查看 Run 的执行过程，而不是只能等待最终结果。

支持 Event Stream 和实时 Logs。

## 10. Artifacts

Agent 执行过程中产生的结果应该能够作为 Artifact 保存。

例如：

* 修改后的代码
* Git Diff
* Patch
* Report
* Generated File
* Test Result
* Build Output
* Agent 最终结果

Artifact 应与 Run 关联，并支持查看和获取。

## 11. Usage & Cost

统一记录不同 Provider / Model 的使用情况。

包括：

* Input Tokens
* Output Tokens
* Cached Tokens（如果 Provider 支持）
* Model Requests
* Execution Duration
* Estimated Cost

用户可以查看：

* 单次 Run Cost
* Session Cost
* Model Usage
* Provider Usage
* 历史 Usage

未来可以支持 Budget 和 Cost Limit。

## 12. Secrets

提供统一 Secrets 管理。

用于保存：

* Provider API Key
* Git Credential
* Runtime Credential
* Environment Secret
* 第三方服务 Token

Secret 不应该直接出现在普通配置、日志和 Event 中。

Secrets 可以按需注入 Runtime Container。

## 13. Agent Profile

Agent 不需要成为底层最核心的实体，可以将其设计为一个可复用的配置 Profile。

一个 Agent Profile 可以预先组合：

* Runtime
* Model
* Workspace Configuration
* Tools
* Environment
* Policies
* Resource Limits
* System Instructions

用户创建 Profile 后，可以快速启动多个 Run。

例如：

* Senior Engineer Agent
* Code Review Agent
* Test Agent
* Research Agent

## 14. Execution Policy

允许对 Agent 执行行为进行限制。

例如：

* 最大执行时间
* 最大模型调用次数
* 最大 Token
* 最大 Cost
* CPU / Memory Limit
* Network Policy
* Filesystem Policy
* Shell Permission
* Tool Permission

防止 Agent 无限执行或获得不必要的权限。

## 15. CLI

提供 AgentFabric CLI。

CLI 应覆盖主要操作，包括：

* Provider 管理
* Model 管理
* Runtime 管理
* Agent Profile 管理
* Task 提交
* Run 管理
* Run Logs
* Run Events
* Session 管理
* Artifact 管理
* Config 管理

重点优化从当前代码仓库直接启动 Coding Agent Task 的体验。

## 16. API

AgentFabric 应提供统一 API，使其他系统能够将 AgentFabric 作为 Agent Execution Infrastructure 使用。

API 应覆盖：

* Provider
* Model
* Runtime
* Workspace
* Agent
* Task
* Run
* Session
* Event
* Artifact
* Usage

同时支持实时 Run Event / Log Streaming。

## 17. Web UI

可以提供一个基础管理界面。

主要包括：

* Dashboard
* Providers
* Models
* Runtimes
* Agents
* Workspaces
* Runs
* Sessions
* Artifacts
* Usage
* Settings

其中 Run Detail 页面非常重要，需要能够实时展示 Agent 当前正在执行什么操作。

## 18. Runtime Extensibility

Runtime 必须具有良好的可扩展性。

AgentFabric Core 不应该针对 OpenCode 或 Pi Agent 写大量特殊逻辑。

应该通过统一 Runtime Adapter / Protocol 接入不同 Agent Runtime。

未来社区应该能够开发自己的 AgentFabric Runtime Adapter。

## 19. Multi-Agent / Workflow（后期功能）

架构上为 Multi-Agent Orchestration 留出扩展空间，但不要求第一阶段实现。

未来可以支持：

* 一个 Task 调用多个 Agent
* Agent 之间传递结果
* Sequential Workflow
* Parallel Workflow
* Dependency / DAG
* Planner → Developer → Tester → Reviewer
* Retry
* Conditional Execution
* Human Approval

Workflow 中的每个 Node 可以选择不同的 Runtime 和 Model。

## 20. MVP 范围

AgentFabric 第一阶段不要追求复杂 Multi-Agent Framework。

优先把以下核心链路做好：

**Configure Provider → Configure Model → Choose Runtime → Choose Workspace → Submit Task → Create Container → Execute Agent → Stream Events / Logs → Collect Artifacts → Complete Run**

MVP 优先实现：

* Provider
* Model
* OpenCode Runtime
* Pi Agent Runtime
* Docker Runtime
* Workspace
* Task
* Run
* Session
* Logs
* Events
* Artifacts
* Secrets
* 基础 Usage / Cost Tracking
* CLI
* API
* 基础 Web UI

AgentFabric 的核心设计原则是保持各层能力正交：

**Provider → Model**

以及：

**Task + Runtime + Model + Workspace + Tools + Secrets + Policy → Run**

Runtime 负责执行 Agent，AgentFabric 负责 Runtime 的调度、隔离、生命周期、配置、观察和管理。

最终希望 AgentFabric 成为一个 Runtime-neutral、Model-neutral、Provider-neutral 的 Agent Execution & Orchestration Infrastructure。
