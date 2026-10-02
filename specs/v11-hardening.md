# AgentFabric v11 Hardening：隔离执行、安全边界与发布一致性修复

请基于当前 `main` 分支已经实现的 Project / SourceCredential / Managed Workspace / ExecutionSupervisor / Validation / Git Finalization / Publish / Retry 等能力，完成一轮针对 **Runtime Isolation、Credential Security、Publish Semantics、Crash Recovery** 的架构加固。

本次任务不是重新实现 Project Task Lifecycle，也不要大规模重构现有已经工作的功能。

目标是修复当前实现中仍然存在的几个关键架构缺口，使以下承诺真正成立：

> **Project-based Coding Task 的完整开发生命周期运行在受控的隔离 Runtime 中。**

同时保证：

> **Source Credential 永远不会进入 Agent trust domain。**

以及：

> **Agent Development、Validation、Finalization、Publishing 是相互独立、状态明确、可独立恢复的生命周期阶段。**

---

# 一、背景

当前 AgentFabric 已经基本实现：

```text
Project
→ Task
→ Managed Workspace
→ Source Preparation
→ Runtime
→ Agent
→ Validation
→ Git Finalization
→ Push
→ Completion
```

同时已经具备：

- Project；
- Git Source；
- SourceCredential；
- Secret integration；
- Managed Workspace；
- Base Ref；
- Working Branch；
- Base Commit SHA；
- Execution Supervisor；
- Skills / MCP provisioning；
- Agent execution；
- Validation；
- Git Finalization；
- Publish；
- Retry Validation；
- Retry Publish；
- Workspace locking；
- lifecycle event；
- v11 integration tests。

这些能力应尽可能保留。

本次重点修复以下问题：

1. Project Coding Task 仍然可以使用 Local Runtime；
2. Validation 当前在 AgentFabric Host 执行；
3. Git Credential 的 Secret Scope 尚未形成真正的授权边界；
4. SourceCredential 的 host 与 Repository remote host 没有强绑定；
5. Retry Publish 可能重新 Finalize / 创建新的 commit；
6. Crash Recovery 会错误覆盖已经完成的 Agent 状态；
7. 当前 E2E 没有真正验证 Docker 隔离生命周期。

---

# 二、本次核心目标

完成后必须实现以下安全与执行模型：

```text
AgentFabric Control Plane
        │
        ▼
Execution Supervisor
        │
        ├── Workspace lifecycle
        ├── Git source lifecycle
        ├── Credential broker
        ├── Runtime lifecycle
        ├── Validation lifecycle
        ├── Git finalization
        └── Publish
        │
        ▼
Isolated Runtime
        │
        ├── Harness
        ├── Agent
        ├── Skills
        ├── MCP
        └── Workspace mount
```

必须满足以下边界：

```text
Agent Runtime
    !=
AgentFabric Host

Git Credential
    !=
Agent Secret

Validation
    !=
Host shell execution

Retry Publish
    !=
Re-finalize Task

Agent Completed
    !=
Task Fully Completed
```

---

# 三、Project Coding Task 必须运行在隔离 Runtime

## 3.1 当前问题

当前 Project-based Task 可以选择：

```text
containerized = false
```

的 Runtime。

这意味着 Coding Task 可能直接在 AgentFabric Host 上运行。

这与当前功能的核心目标不一致。

---

# 四、Runtime Policy

Project-based Coding Task 默认必须要求：

```text
containerized = true
```

或者等价的：

```text
isolationMode = sandboxed
```

具体字段设计遵循现有 Runtime 模型即可。

关键行为要求：

> 普通 Project Coding Task 不允许使用 Local Host Runtime。

如果用户选择不满足 isolation requirement 的 Runtime：

必须在 Task / Run 启动前拒绝。

不能启动后才失败。

---

## 4.1 Local Runtime

现有 Local Runtime 能力不要求删除。

它仍然可以服务于：

- development；
- debugging；
- non-project task；
- advanced usage；
- internal test。

但是 Project Coding Task 默认不能使用。

如果未来希望允许：

```text
allowHostExecution
```

必须作为显式的高级安全策略。

本次不要求开放给普通用户。

---

## 4.2 Runtime Capability

不要依赖：

```text
runtime.name === "docker"
```

判断。

应根据明确 capability / isolation metadata 判断。

例如：

```text
containerized
sandboxed
isolated
```

具体命名遵循现有模型。

---

# 五、Validation 必须进入隔离环境

## 5.1 当前问题

当前 Validation 会在 AgentFabric Host 上执行：

```text
sh -c <validation command>
```

同时继承 Host `process.env`。

这是本次必须修复的问题。

Repository 内容属于不可信输入。

以下命令：

```text
npm test
npm run build
pytest
cargo test
make test
```

都可能执行 Repository 内代码。

因此：

> Validation Command 必须视为不可信代码执行。

---

# 六、Validation Runtime

Validation 必须在隔离环境执行。

允许以下两种实现之一：

### Option A

复用当前 Task Runtime。

```text
Agent finished
↓
same isolated runtime
↓
validation
```

### Option B

创建新的 disposable Validation Runtime。

```text
Agent finished
↓
destroy / stop agent runtime
↓
create isolated validation runtime
↓
mount same Workspace
↓
validation
```

两者都可以。

具体实现根据当前 Runtime abstraction 选择。

---

## 6.1 Validation 安全要求

Validation 不允许：

- 在 AgentFabric Host 上直接执行 Repository command；
- 默认继承整个 `process.env`；
- 自动获得 Git Source Credential；
- 自动获得所有 Task Secret；
- 自动获得 Docker socket；
- 自动获得 Host filesystem access。

Validation 环境必须使用 allowlist 方式构建。

---

## 6.2 Validation Environment

Validation 只允许获得：

- Workspace；
- 必要 runtime environment；
- 明确允许的 Task env；
- 明确允许的 build/test secret。

Git Source Credential 不属于 Validation Secret。

---

## 6.3 Validation 生命周期

Validation 仍然需要保持独立 phase：

```text
validation.pending
validation.running
validation.completed
validation.failed
```

Validation failure 不能覆盖：

```text
agent.completed
```

---

# 七、Git Credential 必须成为真正的安全 Scope

## 7.1 当前问题

SourceCredential 对应的 Secret 已经拥有类似：

```text
scope = git
```

的 metadata。

但是通用 Runtime Secret Injection 仍然可能通过 Secret ID 将该 Secret 注入 Agent。

这意味着目前：

```text
scope
```

只是描述信息，而不是授权机制。

必须修复。

---

# 八、Secret Authorization

Secret scope 必须在底层强制执行。

不能依赖 API caller 自己遵守约定。

至少需要形成：

```text
Secret Scope

git
runtime
mcp
validation
...
```

或者等价的 capability model。

本次重点保证：

> `git` scope Secret 只能被 Git Credential Broker 使用。

---

## 8.1 Git Secret 禁止进入 Agent Runtime

必须明确禁止：

```text
scope = git
```

的 Secret 通过以下路径进入 Agent：

- runtime secretIds；
- environment variable；
- MCP secret；
- Harness config；
- skill config；
- task env；
- generic secret resolution。

即使调用者明确传入该 secret ID，也必须在底层拒绝。

---

## 8.2 Git Secret 禁止进入 Validation Runtime

同样禁止：

```text
git scoped secret
```

进入 Validation。

Git credential 只允许用于：

```text
clone
fetch
remote inspection
push
```

等明确的 Source Manager / Credential Broker operation。

---

## 8.3 Authorization 必须在 Secret Resolution Boundary 实现

不要仅仅在 UI 或 Task API 中做过滤。

必须在：

```text
Secret resolution
或
Runtime secret provisioning
```

等底层公共边界强制执行。

目标是：

> 即使未来增加新的调用路径，也不能意外把 Git Credential 注入 Agent。

---

# 九、SourceCredential Host Binding

## 9.1 当前问题

SourceCredential 已保存：

```text
host
```

但当前 Credential resolve 并没有真正验证：

```text
credential.host
```

是否和：

```text
repository remote host
```

匹配。

必须增加约束。

---

# 十、Repository Host Validation

在使用 Credential 前，需要从 Repository Remote URL 解析真实 Host。

例如：

```text
https://github.com/org/repo.git
→ github.com
```

或者：

```text
git@github.com:org/repo.git
→ github.com
```

然后验证：

```text
SourceCredential host
```

是否允许访问该 Remote Host。

---

## 10.1 Host Pattern

可以支持：

```text
github.com
gitlab.com
git.example.com
*.internal.example.com
```

是否支持 wildcard 根据现有设计决定。

如果暂时只支持 exact match 也可以。

关键要求：

> Credential 不允许被发送到未授权 Host。

---

## 10.2 Credential Transport Validation

需要验证 Credential 类型与 remote transport 的基本兼容性。

例如：

```text
HTTPS token
```

不应被错误用于纯 SSH authentication path。

```text
SSH private key
```

不应被错误作为 HTTPS token 使用。

如果 Project Source 配置不兼容：

应在 Project create / update 或 Task source preparation 之前尽早失败。

---

# 十一、Credential Leakage Prevention

继续保证以下敏感值不得进入：

- log；
- event；
- API response；
- error；
- stdout；
- stderr；
- `.git/config`；
- remote URL；
- Task metadata；
- Run metadata。

---

## 11.1 HTTPS

禁止持久化：

```text
https://TOKEN@host/repo.git
```

---

## 11.2 SSH

Private key 必须：

- 临时 materialize；
- 权限正确；
- operation 后 cleanup；
- 不放入 Workspace；
- 不进入 Agent Runtime。

---

# 十二、Retry Publish 必须成为纯 Publish Operation

## 12.1 当前问题

当前 Retry Publish 虽然不会重新执行 Agent，但 publish-only lifecycle 仍然会进入：

```text
finalizeGit()
```

如果 Workspace 出现新的 dirty changes，可能产生新的 commit。

这违反了：

> Retry Publish 只重新发布已经确定的开发结果。

必须修复。

---

# 十三、Frozen Final Revision

首次 Git Finalization 成功后，需要冻结：

```text
finalCommitSha
```

以及必要的：

```text
workingBranch
remoteBranch
```

之后 Publish 应针对这个明确 revision 执行。

例如语义：

```text
finalizedRevision = abc123
```

Publish：

```text
push abc123 → refs/heads/task-branch
```

具体 Git command 可以根据现有实现决定。

---

# 十四、Retry Publish 行为

Retry Publish 必须：

- 不运行 Agent；
- 不运行 Validation；
- 不重新执行 Finalization；
- 不自动创建新的 commit；
- 不修改 Workspace；
- 不重新计算 finalCommitSha；
- 只重新尝试发布已经冻结的 revision。

---

## 14.1 Workspace Changed After Finalization

如果 Finalization 后 Workspace 又被修改：

Retry Publish 不应该把这些修改一起发布。

可以选择：

### 行为 A

继续 push 已冻结的 finalCommitSha。

或者：

### 行为 B

检测 Workspace 已偏离并返回：

```text
workspace-diverged-after-finalization
```

两者都可以。

但绝不能静默产生新 commit。

---

## 14.2 Retry Publish Lock

即使 Retry Publish 理论上只读 Workspace Git 状态，也需要评估与其他 Run 的并发关系。

必须保证：

```text
Retry Publish
```

不会和正在修改同一 Workspace 的 active Run 产生竞态。

可以：

- 获取 Workspace read/write lock；
- 或通过 frozen SHA 完全脱离 mutable working tree。

优先采用语义更清晰的实现。

---

# 十五、Publish 必须限制目标

Publish 必须只能针对当前 Task 已登记的：

```text
remote repository
working branch
final commit
```

不能：

- arbitrary branch；
- arbitrary remote；
- force push；
- push tags。

除非未来增加独立 policy。

本次默认全部禁止。

---

# 十六、Crash Recovery 状态修复

## 16.1 当前问题

Supervisor crash / restart recovery 当前可能无条件将：

```text
agent.status
```

设置为：

```text
failed
```

即使 crash 发生时 Agent 已经完成，系统只是处于：

```text
validation.running
```

或：

```text
git.pushing
```

阶段。

必须修复。

---

# 十七、Stage-specific Recovery

Recovery 必须根据 crash 时的 phase 判断哪些阶段已经完成。

例如：

### Crash during Agent

```text
agent = interrupted / failed
validation = not_started
publish = not_started
```

### Crash during Validation

```text
agent = completed
validation = interrupted / failed
publish = not_started
```

### Crash during Finalization

```text
agent = completed
validation = completed
finalization = interrupted
publish = not_started
```

### Crash during Publish

```text
agent = completed
validation = completed
finalization = completed
publish = interrupted / failed
```

不能反向破坏已经成功的状态。

---

# 十八、Recovery Retry Action

Recovery 之后应该能够给出正确的下一步操作。

例如：

```text
agent interrupted
→ Retry Agent
```

```text
validation interrupted
→ Retry Validation
```

```text
publish interrupted
→ Retry Publish
```

不要统一变成：

```text
Retry Task
```

---

# 十九、Runtime / Supervisor Trust Boundary

保持以下原则：

```text
Supervisor
=
Privileged orchestration component

Agent Runtime
=
Untrusted execution environment
```

Agent 不应自然获得：

- Source Credential；
- Docker socket；
- Host filesystem；
- Supervisor internal API；
- arbitrary Secret Store access；
- arbitrary Publish capability。

---

# 二十、Runtime Shim

如果当前 Runtime 内已有 runner / shim，继续保持其职责最小化：

```text
start harness
forward signals
heartbeat
stdout / stderr transport
structured event forwarding
exit reporting
```

不要为了实现上述功能把完整 Supervisor 和 Git Credential 放进 Container。

---

# 二十一、真实 Docker E2E

当前已有 v11 E2E 使用：

- real API；
- real Git CLI；
- real bare remote；
- mock Runtime。

需要保留现有测试。

但本次必须新增至少一条：

> **真实 Docker Runtime Coding Task E2E。**

---

# 二十二、Docker E2E 必须覆盖

完整链路至少为：

```text
Create Project
↓
Create Task
↓
Create Managed Workspace
↓
Clone Git Repository
↓
Resolve Base Ref
↓
Create Working Branch
↓
Create Docker Runtime
↓
Mount Workspace
↓
Run Test Harness / Fake Agent inside Docker
↓
Modify Workspace
↓
Run Validation inside isolated Runtime
↓
Finalize Git
↓
Commit
↓
Push Remote Branch
↓
Destroy Runtime
↓
Verify Workspace Still Exists
↓
Verify Remote Branch
```

---

# 二十三、Docker E2E Harness

E2E 不要求调用真实 LLM。

可以使用：

```text
fake harness
test harness
deterministic agent
```

只要它真正：

> 运行在 Docker Container 内。

例如 Fake Agent 可以：

```text
write file
modify file
exit success
```

关键测试目标是 Runtime Isolation，而不是模型能力。

---

# 二十四、Docker E2E 必须验证

至少验证：

### Runtime Isolation

Agent process 确实运行在 container 中。

### Workspace Mount

Agent 对 Workspace 的修改正确落盘。

### Runtime Destruction

Task 完成后 Container 被销毁。

### Workspace Persistence

Container 删除后 Workspace 仍存在。

### Validation Isolation

Validation 也在 container / isolated environment 内执行。

### Git Credential Isolation

Agent process environment 中不存在 Source Credential。

### Publish

最终 branch 正确 push 到测试 remote。

---

# 二十五、Host Escape Tests

增加测试确保 Project Task 不会意外 fallback 到 Local Runtime。

例如：

```text
Project Task
+
local runtime
```

应该：

```text
rejected before execution
```

除非明确启用了特殊 override policy。

---

# 二十六、Validation Isolation Tests

至少覆盖：

### Case A

Validation command 可以正常读取 Workspace。

### Case B

Validation command 无法读取 AgentFabric Host-only secret。

### Case C

Validation 不继承完整 `process.env`。

### Case D

Validation 无法读取 Git Source Credential。

### Case E

Validation failure 正确更新 Validation 状态，但：

```text
agent.status
```

保持 completed。

---

# 二十七、Secret Scope Tests

必须新增针对授权边界的测试。

至少覆盖：

### Case A

`scope=git` Secret 可以被 Source Manager 用于 clone。

### Case B

`scope=git` Secret 可以被 Publisher 用于 push。

### Case C

`scope=git` Secret 通过 Task `secretIds` 注入 Runtime：

必须失败。

### Case D

`scope=git` Secret 被 MCP 引用：

必须失败。

### Case E

`scope=git` Secret 被 Validation 引用：

必须失败。

### Case F

即使调用底层 Secret resolve API，也必须执行 scope policy。

---

# 二十八、Credential Host Tests

至少覆盖：

### HTTPS match

```text
credential host = github.com
remote = https://github.com/a/b.git

→ allowed
```

### HTTPS mismatch

```text
credential host = github.com
remote = https://evil.example/a/b.git

→ rejected
```

### SSH match

```text
credential host = gitlab.com
remote = git@gitlab.com:a/b.git

→ allowed
```

### SSH mismatch

```text
credential host = gitlab.com
remote = git@other.example:a/b.git

→ rejected
```

### Transport mismatch

```text
https-token credential
+
ssh remote
```

应明确拒绝或根据正式支持策略处理。

不能静默降级。

---

# 二十九、Credential Redaction Tests

测试中使用明显可识别的 fake secret，例如：

```text
AGENTFABRIC_TEST_SECRET_DO_NOT_LEAK
```

完整生命周期结束后搜索：

- logs；
- events；
- errors；
- DB metadata；
- Workspace；
- `.git/config`；
- Runtime stdout；
- Runtime stderr。

必须确认没有泄漏。

---

# 三十、Retry Publish Tests

重点增加：

### Case A

```text
Agent completes
Finalization creates commit A
Push fails
Retry Publish
```

必须：

```text
push commit A
```

而不是创建 commit B。

---

### Case B

第一次 push 失败后，人为修改 Workspace。

然后：

```text
Retry Publish
```

不得将新修改自动 commit。

---

### Case C

Retry Publish 必须确认：

```text
Agent run count unchanged
Validation run count unchanged
Finalization count unchanged
```

---

### Case D

Retry Publish 成功后：

```text
finalCommitSha
```

保持不变。

---

# 三十一、Crash Recovery Tests

至少覆盖：

### Crash during Agent

Recovery 后：

```text
agent != completed
```

允许 Retry Agent。

---

### Crash during Validation

Recovery 后：

```text
agent = completed
validation = failed/interrupted
```

允许 Retry Validation。

---

### Crash during Publish

Recovery 后：

```text
agent = completed
validation = completed
finalization = completed
publish = failed/interrupted
```

允许 Retry Publish。

---

### Recovery 不得重复 Agent execution

如果 crash 发生在 Agent 已完成之后：

Supervisor restart 后不得自动重新运行 Agent。

---

# 三十二、Concurrency Tests

需要验证：

```text
Task A
Task B
```

属于同一个 Project 时：

- 各自 Runtime 独立；
- Workspace 独立；
- branch 独立；
- Credential 使用互不影响。

同时验证：

```text
Retry Publish Task A
```

不会阻塞或污染：

```text
Task B Workspace
```

---

# 三十三、Cancellation Tests

Project Task 在以下阶段被 Cancel：

```text
agent.running
validation.running
```

都应：

- 停止对应 Runtime process；
- 清理 Runtime；
- 清理 temporary credential；
- 保留 Workspace；
- 不错误执行 publish。

---

# 三十四、错误模型

本次建议补充或确认以下错误类型。

### Runtime

```text
runtime-not-isolated
runtime-not-allowed-for-project-task
```

### Validation

```text
validation-runtime-failed
validation-runtime-unavailable
validation-secret-not-allowed
```

### Credential

```text
credential-host-mismatch
credential-transport-mismatch
secret-scope-not-allowed
```

### Publish

```text
publish-revision-missing
workspace-diverged-after-finalization
remote-branch-conflict
```

具体命名遵循当前项目 convention。

---

# 三十五、Observability

Event / State 必须能够看出以下阶段之间的差别：

```text
Agent
Validation
Finalization
Publish
```

例如 Task Detail 应可以表达：

```text
Agent
completed

Validation
completed

Finalization
completed
commit = abc123

Publish
failed
reason = auth failure
```

而不是只暴露：

```text
Task failed
```

---

# 三十六、状态单调性

已经成功完成的阶段不能因为后续失败被倒退覆盖。

例如：

```text
agent.completed
```

不能因为：

```text
publish.failed
```

变成：

```text
agent.failed
```

同理：

```text
validation.completed
```

不应因为 Retry Publish 失败而改变。

---

# 三十七、Backward Compatibility

本次修复不应破坏：

- Handoff；
- Native State；
- External Workspace；
- Existing Local Runtime；
- non-project Run；
- Secret API；
- existing v11 Project workflow；
- existing CLI / API。

如果必须改变 API：

需要提供合理 migration / validation error。

---

# 三十八、README / Architecture Documentation

完成后同步修改文档。

特别需要明确以下内容。

---

## Project Task Runtime Policy

说明：

> Project Coding Task 默认只能运行在 isolated Runtime。

---

## Validation

说明：

> Repository validation command 视为不可信代码，因此在 sandbox 中执行，而不是 AgentFabric Host。

---

## Source Credential

说明：

> Source Credential 只用于 Source Manager / Publisher，不属于 Agent Runtime Secret。

---

## Secret Scope

解释不同 Secret Scope 的授权语义。

---

## Retry Publish

明确：

> Retry Publish 重新发布已经 Finalize 的 commit，不重新运行 Agent、不重新 Validation、不重新 Finalization。

---

## Crash Recovery

说明 lifecycle stage 在 Supervisor restart 后如何恢复。

---

# 三十九、验收标准

完成后必须满足以下 Acceptance Criteria。

### AC-1

普通 Project Coding Task 不能选择非隔离 Local Runtime。

### AC-2

不满足 Runtime isolation requirement 的 Task 在启动前失败。

### AC-3

Agent 执行在真实 Docker / isolated Runtime 中。

### AC-4

Runtime 可以被销毁，而 Workspace 保持存在。

### AC-5

Validation 不再通过 AgentFabric Host shell 执行。

### AC-6

Validation 在 isolated Runtime 中执行。

### AC-7

Validation 不继承完整 Host process environment。

### AC-8

Validation 无法访问 Source Credential。

### AC-9

Git scoped Secret 不能通过普通 Task secret injection 进入 Agent。

### AC-10

Git scoped Secret 不能通过 MCP secret path 进入 Agent。

### AC-11

Git scoped Secret 不能进入 Validation Runtime。

### AC-12

Git Credential 只能由明确授权的 Git operation 使用。

### AC-13

Credential Host 必须与 Repository Host 匹配。

### AC-14

HTTPS / SSH Credential 与 Repository transport 不兼容时能够明确失败。

### AC-15

Credential 不出现在 `.git/config`。

### AC-16

Credential 不出现在 logs / events / errors / stdout / stderr。

### AC-17

Finalization 成功后保存明确 `finalCommitSha`。

### AC-18

Publish 使用已经冻结的 `finalCommitSha`。

### AC-19

Retry Publish 不重新执行 Agent。

### AC-20

Retry Publish 不重新执行 Validation。

### AC-21

Retry Publish 不重新执行 Git Finalization。

### AC-22

Retry Publish 不创建新的 commit。

### AC-23

Retry Publish 后 `finalCommitSha` 保持不变。

### AC-24

Finalization 后 Workspace 新增修改不能被 Retry Publish 静默发布。

### AC-25

Publish 只能发布当前 Task working branch。

### AC-26

默认禁止 force push。

### AC-27

Supervisor crash 在 Validation 阶段时，Agent 仍保持 completed。

### AC-28

Supervisor crash 在 Publish 阶段时，Agent 和 Validation 都保持 completed。

### AC-29

Recovery 能给出正确的 Retry Agent / Retry Validation / Retry Publish 行为。

### AC-30

至少存在一条真实 Docker Runtime E2E。

### AC-31

Docker E2E 使用真实 Workspace mount。

### AC-32

Docker E2E 验证 Runtime 销毁后 Workspace 存在。

### AC-33

Docker E2E 验证 Validation 也在 sandbox 内运行。

### AC-34

Docker E2E 验证 Agent Runtime 中不存在 Git Credential。

### AC-35

Docker E2E 最终能够将 Task branch 推送到测试 Remote。

### AC-36

现有 Handoff / Native State 测试仍然通过。

### AC-37

现有 v11 tests 不应发生不合理 regression。

---

# 四十、必须新增的完整 E2E 场景

最终至少需要存在以下一条完整验收测试：

```text
Create Git Credential
        ↓
Create Project
        ↓
Create Task
        ↓
Create Managed Workspace
        ↓
Clone Private/Test Repository
        ↓
Resolve Base Commit
        ↓
Create Working Branch
        ↓
Start Real Docker Runtime
        ↓
Run Fake Agent Inside Docker
        ↓
Modify Workspace
        ↓
Verify Agent Cannot Read Git Credential
        ↓
Run Validation Inside Sandbox
        ↓
Finalize Git
        ↓
Freeze Final Commit SHA
        ↓
Push Exact Final Commit
        ↓
Destroy Docker Runtime
        ↓
Verify Workspace Still Exists
        ↓
Verify Remote Branch
        ↓
Verify Secret Never Leaked
```

---

# 四十一、Publish Failure E2E

另外增加：

```text
Agent completed
↓
Validation completed
↓
Finalization completed
↓
Final commit = A
↓
Push intentionally fails
↓
Task publish status = failed
↓
Agent remains completed
↓
Validation remains completed
↓
Retry Publish
↓
Push A succeeds
↓
No new Agent Run
↓
No Validation rerun
↓
No new commit
```

---

# 四十二、Recovery E2E / Integration Test

至少模拟：

```text
Agent completed
↓
Validation completed
↓
Publishing
↓
Supervisor crash
↓
Supervisor restart
```

恢复后应得到：

```text
Agent = completed
Validation = completed
Publish = interrupted / failed
```

随后：

```text
Retry Publish
```

能够完成，而不重新执行 Agent。

---

# 四十三、实现方式要求

正式修改前：

1. 阅读当前 Project / Task / Workspace / Runtime / Supervisor / Validation / Secret / Credential / Git Finalizer 实现；
2. 阅读当前 v11 tests；
3. 明确现有 Runtime capability model；
4. 明确当前 Secret resolve 路径；
5. 明确 Validation 当前执行位置；
6. 明确 Retry Publish 当前调用链；
7. 明确 recovery 当前状态恢复算法。

之后再开始实现。

---

# 四十四、不要做的事情

本次不要：

- 重写 Project 模型；
- 重写 Handoff；
- 重写整个 Runtime abstraction；
- 增加复杂 PR/MR 功能；
- 增加 GitHub-specific workflow；
- 增加 multi-repository；
- 增加 distributed scheduler；
- 引入 Kubernetes；
- 为了测试调用真实 LLM。

本次目标是：

> **把已经完成的 Project Coding Task Lifecycle 收紧到正确的 Runtime Isolation 和 Security Boundary。**

---

# 四十五、完成要求

不能只修改代码而没有测试。

完成后必须：

1. 运行全部现有测试；
2. 新增上述 security / lifecycle 测试；
3. 新增真实 Docker E2E；
4. 修复 regression；
5. 更新 README / architecture docs；
6. 对完整 lifecycle 实际运行验证。

最后输出开发总结，包括：

- 修改了哪些架构行为；
- Runtime isolation 如何 enforce；
- Validation 现在在哪里执行；
- Secret scope 如何 enforce；
- Credential host 如何验证；
- Retry Publish 如何保证 revision immutable；
- Crash recovery 如何保持 stage 状态；
- 新增了哪些测试；
- Docker E2E 结果；
- 全量测试结果；
- 尚未解决的问题。

本任务完成的最终判断标准不是“相关代码已经存在”，而是：

> **Project Coding Task 从 Agent Execution 到 Validation 的不可信代码执行均处于隔离 Runtime；Git Credential 始终处于 Agent trust domain 之外；Finalization 结果可冻结，Publish 可独立重试；Supervisor crash 不会破坏已经完成阶段的状态语义。**