# Validation：验收标准与 Validation Agent

Project Coding Task 在开发 Agent 完成、Git 定稿之前，交给一个**独立的 Validation Agent** 判定是否满足验收标准。标准是一段**自然语言**（"go 编译与全量测试通过"），不是命令列表——judge 自己在隔离容器里运行它认为需要的命令并给出结论。

机制设计（为什么是第二个 Agent、代码为什么不可信、pin 与回放）见 README 的「Validation：第二个 Agent 的独立判定，代码不可信」一节。本文只讲**怎么用**。

## 配置入口

Validation 是一项**配置**：

| 入口 | 位置 | 作用范围 |
| --- | --- | --- |
| Web · 创建项目 | Projects → New project → Validation | 该项目所有 Task |
| Web · 项目内建 Task | 项目详情 → New task → Validation | 单个 Task，**整体替换**项目配置 |
| Web · 侧边栏建 Task | 侧边栏 New task → Validation 折叠区 | 单个 Task，同上 |
| REST API | `POST /api/projects`、`PUT /api/projects/:id`、`POST /api/projects/:id/tasks` | `validation: { prompt, maxAttempts?, modelId?, timeoutMs? }`；判定的密钥在 `execution.validationSecretIds` |
| CLI | `af projects add` / `update --validation-prompt "..." [--validation-max-attempts N]` | Project 级 |

规则：

* **没配置 = 跳过判定**：Task 行为与没有这一机制时完全一致（事件 `validation.skipped`，不产生 pin 与 judge run）。
* **配置了就必须可用**：prompt 为空或全空白是 `config-invalid`（400），在创建/更新时就被拒绝——**绝不静默跳过**。
* **替换而非合并**：Task 有 `validation` 就整体替换 Project 的；没有则继承。
* `maxAttempts`（默认 3）与 `modelId`（judge 的模型，默认跟随 Task）都可选。

```jsonc
// POST /api/projects —— Project 级
{
  "name": "my-service",
  "source": { "remoteUrl": "https://github.com/you/my-service.git" },
  "validation": {
    "prompt": "`go build ./...` and `go test ./...` both pass with no new failures",
    "maxAttempts": 3
  }
}

// POST /api/projects/:id/tasks —— Task 级（整体替换）
{
  "instruction": "Add the /health endpoint",
  "validation": { "prompt": "the /health endpoint returns 200 with {\"status\":\"ok\"}, proven by a test" }
}
```

**prompt 怎么写**：写"可被证据支撑的验收标准"，不是"要改哪个文件"。judge 会运行命令、读输出，所以「命令行能证明的事」判起来最可靠：

* 好：`` `make test` passes ``；`` `go build ./...` exits 0 and `curl localhost:8080/health` returns 200 ``；「README 里记录了新的环境变量且 `npm run typecheck` 通过」。
* 差：「代码质量好」——没有可运行的证据；judge 只能给含糊结论。

## 判定循环

```text
开发 run 完成
    ↓
完工 pin（工作区固定成一个 commit，附注 af-pin: <runId>）
    ↓
judge run（新容器、workspace 只读、模型默认跟随 Task）
    ↓
verdict：passed → Git Finalization → Publish
         failed → 返工 run（同一 workspace，携带判定结论）→ 重新 pin → 再判
    ↓
最多 3 次判定（默认）仍不通过 → Task 以 validation-failed 终止
```

语义要点：

* **返工是真实的开发 run**（`purpose: "rework"`，计为一次 agent attempt），指令 = 原任务 + judge 的结论与未满足项。**validation prompt 本身不会被注入给开发 Agent**——它拿到的是缺陷清单，不是可以对着作弊的标准。
* **返工 run 自身失败**（agent-failed / timeout / cancelled / runtime-*）→ 立即终止 Task，不再判定。
* **判定不通过 ≠ 开发失败**：`execution.failure.stage = "validation"`，但 agent 的状态与 stages 始终反映开发 run 的真实结果。
* **不消耗预算的失败**：judge 没产出合法 verdict（`validation-verdict-missing`）、judge 超时（`validation-timeout`）、沙箱起不来（`validation-runtime-*`）都不算一次判定——环境问题可重试，autoRetry 会命中其中的瞬态错误码。

## verdict 怎么读

judge 通过平台生成的工具提交结构化判定：

```jsonc
{
  "passed": false,
  "summary": "The build passes but the new endpoint has no test.",
  "unmet": ["a test covers the /health endpoint"],
  "evidence": [
    "`go build ./...` → exit 0",
    "`go test ./...` → 12 pass, but no test references /health"
  ]
}
```

* verdict 在**生成时冻结**到 Task 记录上（`execution.validation.verdict` 与每轮 `rounds[].verdict`），并作为 `validation-verdict.json` artifact 挂在开发 Run 上；读取路径永远原样返回，不重算。
* `evidence` 是 judge 实际跑过的命令与观察结果——**判定纪律基于真实证据**，空 evidence 或 failed 却不给 unmet 的 payload 都会被工具以退出码 2 拒绝（judge 会看到原因并自我修正）。

**在哪里看**：

* **Task Lifecycle 页**：validation 轮次视图——每轮的完工 pin（commit 前 8 位）、judge run 链接、返工 run 链接、verdict 全文；顶部显示 `attempts / maxAttempts`。
* **CLI**：`af tasks detail <id>` 打印 validation 状态、判定次数/轮次与最近一次 verdict。
* **事件流**：`validation.round.started` → `validation.pinned` → `validation.verdict` → `validation.passed` / `validation.failed`；返工有 `validation.rework.started`；judge 弄脏了工作区有 `validation.workspace.replayed`。
* **Run Inspector**：judge 是一次普通 Run，它的完整执行（命令、输出、usage）都在里面。

## 判定期间代码安全（不用你操心，但值得知道）

两层机制保证 judge 不可能把代码写进最终产物：

1. Workspace 在 judge 容器里是**只读挂载**；
2. 判定对象是**完工 pin**（固定 commit），judge 结束后平台比对工作区指纹，出现任何意外 commit / 改动 / untracked / 换分支 → 响亮记录 `validation.workspace.replayed` 并回放到 pin。

所以 judge 想构建/测试时需要**在容器内复制一份工作树**（judge 的 instructions 里已经写好怎么做），这也是为什么 judge 的只读挂载不影响它运行 `go build` / `npm test`。

## 重试语义

| 操作 | 入口 | 语义 |
| --- | --- | --- |
| **Retry Validation** | Lifecycle 页按钮 · `af tasks retry-validation <id>` · `POST /api/tasks/:id/retry-validation` | **重置预算、重跑一轮**：不重新开发、不调用开发模型；attempts 归零、rounds 历史保留。判定可能再次触发返工（judge 觉得代码还不够格时） |
| **Retry Agent Run** | `af tasks retry-run <id>` · `POST /api/tasks/:id/retry-run` | 新 run、同 workspace；validation 循环随之重新开始（新循环 = 新预算） |
| **Retry Publish** | `af tasks retry-publish <id>` · `POST /api/tasks/:id/retry-publish` | 只重新 push 冻结的 revision；不重新判定 |

没有配置 validation 的 Task 调用 Retry Validation 会被拒绝（`task-state-invalid`，400）——没有标准可重判。

**预算耗尽之后怎么办**：`validation-failed` 之后 Task 不会自己再跑。人工介入的路径：

1. 看 verdict 的 `unmet` 与 `evidence`，判断是"代码确实不够"还是"judge 的标准/环境有问题"；
2. 代码不够 → 直接在 Task Thread 里继续对话让 Agent 修（或手工改 workspace 后）→ **Retry Validation** 给新预算重判；
3. 标准写得不好（判不出来、误判）→ 更新 Project/Task 的 validation prompt，再 Retry Validation；
4. 反复误判 → 考虑把标准写得更有可运行证据（见上文"prompt 怎么写"），或调大 `maxAttempts`。

## 常见坑

* **judge 容器需要 `node`**。verdict 工具是 Node 脚本；judge 镜像（= 任务 Runtime 的 image）里没有 node 时，judge 仍可按 instructions 的兜底路径手写 `verdict.json`，但更省事的做法是让镜像带上 node。
* **只读挂载是刻意的**。看到 judge 说"无法写入"是预期行为——它应该在 `/tmp` 里复制一份再构建（instructions 里有命令模板）。它不是让你把挂载改成读写。
* **标准别写成实现步骤**。"把 X 函数改成 Y" 是给开发 Agent 的指令；验收标准应该写"改完之后什么为真"，并且尽量能被命令证明。
* **judge 的密钥是另一套 allowlist**。需要私有 registry token 之类的构建密钥走 `validationSecretIds`（与 Agent 的 `secretIds` 互相独立）；`scope: "git"` 的密钥在这里会被拒绝（`validation-secret-not-allowed`，403）。
* **判定轮次是留痕的**。Retry Validation 会把新循环的轮次**追加**到 `rounds` 后面（round 号连续），不会覆盖历史——审计时看到的是一整条时间线。

## 边界

* 只有 **Project Coding Task** 有判定循环。非 Project 的经典 Run（`POST /api/runs`）没有 validation。
* judge 是普通 Run，但被平台约束：只读工作区、verdict 输出目录是唯一可写挂载、生命周期强制 `ephemeral`、不注入开发侧的 skills / MCP、网络与 agent 用同一份 policy、拿不到 Git credential 与 Task 的 `secretIds`。
* 判定期间取消：在飞的 judge / 返工 run 被终止，validation 记 `interrupted`（可 Retry Validation 恢复）。
* 崩溃恢复：崩在 judge → 重判该轮；崩在返工 run → 对当前（可能只改了一半的）工作区重新判定，不通过会自然再次返工；崩在 pin 已写入、judge 未开始的窗口 → 先做一次漂移检测（重启期间可能有残留写入），需要则回放，再起 judge。都不消耗预算。
