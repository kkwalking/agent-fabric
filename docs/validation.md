# Validation：任务校验机制

Project Coding Task 在 Agent 完成后、Git 定稿前运行的一组校验命令（typecheck / test / lint / build）。它是平台的独立阶段：校验失败**不是**「任务失败」，而是 `validation-failed`，可以单独重试，不重跑 Agent。

机制设计（为什么在容器里跑、环境怎么隔离）见 README 的「Validation：不可信代码，必须在隔离环境执行」一节。本文只讲**怎么用**。

## 配置入口

| 入口 | 位置 | 作用范围 |
| --- | --- | --- |
| Web · 创建项目 | Projects → New project → Validation | 该项目所有 Task |
| Web · 项目内建 Task | 项目详情 → New task → Validation override | 单个 Task，**整组替换**项目配置 |
| Web · 侧边栏建 Task | 侧边栏 New task → Validation override 折叠区 | 单个 Task，同上 |
| REST API | `POST /api/projects`、`PUT /api/projects/:id`、`POST /api/projects/:id/tasks` | 可显式给 `name` / `timeoutMs` / `required` |

Web 三个入口都是**每行一条命令**，步骤名自动取命令的第一个词；留空表示继承（Task 级）或不启用（Project 级）。侧边栏 New task 的输入框 placeholder 会显示当前 Project 继承的命令，所见即所得。

`af` CLI（`af projects add / update / start`）目前**没有** validation 参数——CLI 用户走 REST API，或先用 Web 配好 Project 级步骤。

两个已知的编辑边界：

* **Edit project 弹窗不含 validation 字段**。创建后想改 Project 级步骤，用 `PUT /api/projects/:id` 传 `validation`。
* `timeoutMs` / `required` / `validationSecretIds` 只在 API 层暴露，Web 表单不提供。

## Step 定义

```ts
interface ValidationStep {
  name: string;
  command: string;     // 在 Workspace 根目录（容器内 /workspace）执行的 shell 命令
  timeoutMs?: number;  // 默认 10 分钟
  required?: boolean;  // 默认 true：失败即中止后续步骤
}
```

REST 示例：

```jsonc
// POST /api/projects/:id/tasks —— Task 级覆盖（整组替换 Project 的步骤）
{
  "instruction": "…",
  "validation": {
    "steps": [
      { "name": "typecheck", "command": "npm run typecheck" },
      { "name": "test", "command": "npm test", "timeoutMs": 600000 },
      { "name": "lint", "command": "npm run lint", "required": false }
    ]
  }
}
```

语义要点：

* **替换而非合并**：Task 有 `validation` 就整体替换 Project 的；没有则继承。`enabled: false` 或空 `steps` 即跳过校验。
* **顺序执行，遇失败即停**（`required` 为 true 时）；`required: false` 的步骤失败不阻断后续。
* 全部通过才进入 Git 定稿（commit → 冻结 SHA → push）。

## 命令在哪里跑

每次校验尝试创建一个**一次性容器**（`docker run --rm`），跑完即销毁：

```text
docker run --rm --name af-validate-<随机> \
  -v <workspace>:/workspace:rw -w /workspace \
  -e <allowlist 环境> \
  [--network none] \
  --label agentfabric.validation=true \
  <image> sh -c "<step 命令>"
```

* **镜像解析顺序**：任务 Runtime 的 `image` → 环境变量 `AGENTFABRIC_VALIDATION_IMAGE` → 兜底 `node:22-alpine`。容器化 Runtime 的镜像就是仓库期望的工具链，所以优先复用它。
* **环境按 allowlist 构建**，绝不继承宿主 `process.env`：`PATH` / `HOME` / `TMPDIR` / `LANG` / `LC_ALL` / `TERM` / `CI` / `AGENTFABRIC_VALIDATION`，加上任务显式 `env` 和 `validationSecretIds` 解析出的密钥。
* **网络与 Agent 容器同一策略**（同一个 resolver 解析同一份 policy）；`network.enabled = false` 时校验同样是 `--network none`。
* **拿不到的东西**：Git Source Credential、任务 `secretIds`、Docker socket、Workspace 之外的宿主路径。

## 失败分类

| 情况 | errorCode | HTTP | 含义 |
| --- | --- | --- | --- |
| step 退出码非 0 | `validation-failed` | 400 | 代码没过——改代码 |
| step 超时 | `validation-timeout` | 400 | 改代码或调大 `timeoutMs` |
| 沙箱起不来（无 daemon / 无镜像） | `validation-runtime-unavailable` | 502 | 环境问题——重试运行时 |
| 执行器自身异常 | `validation-runtime-failed` | 502 | 同上 |

502 类失败属于「环境坏了」，会被自动重试（`config.autoRetry`）命中；`validation-failed` / `validation-timeout` 属于「活干砸了」，**不**自动重试。校验**绝不**回退到宿主执行。

## 重试

* Web：Task Lifecycle 页（`/tasks/:id/lifecycle`）的 **Retry validation** 按钮。
* CLI：`af tasks retry-validation <id>`。
* API：`POST /api/tasks/:id/retry-validation`。

三者语义相同：只重跑校验，不重跑 Agent，不调用模型。Task 记录上 `agent` 阶段保持 `completed`，校验阶段独立重置。

## 观察与证据

* **Lifecycle 页**：每个 step 的 `status` / `exitCode` / 输出尾部。
* **事件流**：`validation.runtime.prepared` → `validation.started` → `validation.step` → `validation.passed` / `validation.failed`；`shell.command` / `shell.output` 带 `isolated: true`。
* **隔离证据**：`validation.execution` 记录 `backend: "isolated"`、`runtimeKind`、`image`、`disposable: true`。
* **报告**：每次校验产出 `validation-report.txt` artifact（每个 step 的 status / exit code / 输出），`af artifacts list` / `get` 可取。

## 常见坑

* **镜像里必须有工具链**。校验容器用的是「任务 Runtime 的镜像」，如果那个镜像没有仓库需要的编译器/包管理器，`go build` / `npm test` 会直接 exit 1，和代码写错长得一模一样。真实案例：bruce-go 的任务第一次校验因镜像缺 Go 工具链失败，换镜像后 build / vet / test-core 全部通过。
* **命令在容器里跑，路径按容器算**。工作目录是 Workspace 根（容器内 `/workspace`），别写宿主绝对路径。
* **需要密钥的校验**（私有 registry token 等）走 `validationSecretIds`（Project 的 `execution.validationSecretIds` 或 Task 提交体），与 Agent 的 `secretIds` 是**两套** allowlist；`scope: "git"` 的密钥在这里也会被拒绝。

## 边界

* 只有 **Project Coding Task** 有校验阶段。非 Project 的经典 Run（`POST /api/runs`）没有 validation。
* 默认路径下校验命令是**不可信代码**，在一次性容器里执行。Runtime 不满足隔离要求（containerized + image）时任务在创建前就被拒绝——校验镜像的来源正是这个 Runtime 的 image。
* **`allowHostExecution` 会同时放宽校验**：该开关（`SupervisorOptions` 或 `Project.execution.allowHostExecution`，默认关闭，Task 请求体无法开启）本意是 Agent Runtime 的 operator 级逃生阀，但 `supervisor.ts` 的校验门禁与它共用同一条件（`!isolation.sandboxed && !(allowHostExecution || …)`），开启后校验会改走 `validationRunner` 的**宿主 shell** 路径（`runHostValidation`，仍用 allowlist 环境，但不再是容器隔离）。README「Project Task Runtime Policy」一节写的「Validation 的隔离要求不受它影响」与当前实现不符——以代码为准，详见 `packages/core/src/supervisor.ts` 的 `runValidationStage`。
