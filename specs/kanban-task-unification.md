# 统一契约（v2）：看板项目 = Project，看板运行 = Task

本文件是这一轮重构的**唯一事实来源**。所有并行任务按这份契约实现，不要各自发明形状，不要改契约本身。

## 目标

看板（kanban）的项目与任务（task）的项目统一为同一份 `Project` 记录；看板里真正跑起来的卡片产出一条**真正的 Task**，
让它出现在侧边栏「工作区任务树」（`WorkspaceTaskList`）里、落在对应工作区文件夹下，点进去就是普通的 Task 线程。

## 已确认的决定

1. **方案 A**：看板项目**就是** `Project`。看板不再有自己的项目集合。
2. **一张卡片 = 一个 Task**：卡片第一次启动时创建 Task，之后重跑/续聊都是同一个 Task 新增 Run。
3. 显示位置：**侧边栏工作区任务树**（数据来自 `/api/tasks` + `/api/workspaces` + `/api/projects`，前端不需要拼数据）。

## 仓库约定（AGENTS.md，必须遵守）

- **不为旧数据写兼容逻辑**：直接改形状，不留 `if (oldShape)`、不写迁移脚本、不在读取路径兜底。历史看板数据视为脏数据。
- **读就是读**：看板会话状态到 `Task`/`Run` 的投影，只在**写入那一刻**算一次并落库；`GET` 路径原样返回。
- **失败要响**：不可用就抛 `DomainError`（带 code），不静默降级。
- **不要 `git commit` / `git push`**。改完留在工作区等用户审查。
- 改行为要同步 `README.md`（中文）以及必要的 `docs/`。

---

## 一、core 数据模型（`packages/core/src/types.ts`、`kanban.ts`、`store.ts`）

### 删除

- `KanbanProject` 接口整体删除。
- store 集合 `kanbanProjects` 删除：`CollectionName` 联合类型、`Database` 接口字段、`empty()` 初始化、构造函数里的数组兜底都删。
- `KanbanCard.sessionId` 删除（不再有「卡片会话」这层运行记录）。

### `Project` 增加看板字段

```ts
export interface Project {
  // …既有字段不动（id/name/description/source/execution/skills/mcpServers/validation/git/createdAt/updatedAt）
  /** 看板设置：只有从看板加进来的 Project 才有。 */
  board?: ProjectBoardSettings;
}

export interface ProjectBoardSettings {
  workspaceType: KanbanWorkspaceType;
  /** 目录探测失败时的说明；探测只用于展示，永远不阻塞创建。 */
  discoveryWarning?: string;
  defaultAgentId?: KanbanAgentKind;
  defaultExecutionMode?: KanbanExecutionMode;
}
```

**看板根目录一律从 `source` / 外部 Workspace 解析，不在 Project 上再加 `rootPath`**（两份路径必然分叉）。
`ProjectService.update()` 必须支持部分更新 `board`（与既有 `execution` 的「合并而非替换」同样的语义）。

### `KanbanCard` 改指向

```ts
export interface KanbanCard {
  id: ID;
  /** 所属 Project（看板项目就是 Project）。 */
  projectId: ID;
  title: string;
  prompt: string;
  column: KanbanColumn;
  agentId: KanbanAgentKind;
  model?: string;
  reasoningEffort?: string;
  permissionModeId?: string;
  executionMode: KanbanExecutionMode;
  baseRef?: string;
  /** 卡片的工作目录：Project 的外部 Workspace。卡片创建时确定。 */
  workspaceId?: ID;
  /** 这张卡片对应的 Task；第一次启动时创建，之后不再变。 */
  taskId?: ID;
  /** 最近一次运行（= Task 的一个 Run）。 */
  runId?: ID;
  createdAt: string;
  updatedAt: string;
}
```

### `KanbanSession` 保留，但语义收窄为「进程句柄」

它不再是任务记录，而是 PTY/ACP 进程的运行时句柄，与 `Run` **一一对应（`id` 相同）**：

```ts
export interface KanbanSession {
  /** = 对应 Run 的 id（1:1）。 */
  id: ID;
  cardId: ID;
  runId: ID;
  agentId: KanbanAgentKind;
  cwd: string;
  executionMode: KanbanExecutionMode;
  status: KanbanSessionStatus;
  nativeSessionId?: string;
  modelRoute?: KanbanSessionModelRoute;
  reasoningEffort?: string;
  interactiveTui: boolean;
  transport: KanbanSessionTransport;
  lastHookEvent?: string;
  lastHookAt?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
}
```

理由：终端/AChat 的 WebSocket 与 hook token 都按会话 id 索引，进程句柄必须独立存在；但真正的任务记录是 `Task` + `Run`。

---

## 二、投影规则（写时投影，core `packages/core/src/kanban.ts`）

| 看板事件 | 写入 |
| --- | --- |
| 卡片第一次启动 | `TaskService.create()`：`projectId`=卡片项目、`workspaceId`=卡片工作目录、`title`=卡片标题、`prompt`=卡片 prompt、`runtimeId`=agent 对应 runtime、`metadata.board = { cardId }`、`metadata.lastActivityAt`；同一次写入带上完整 `execution`（`phase:"agent.running"`、`status:"running"`） |
| 每次启动（含重跑/续聊） | 新增一条 `Run`：`taskId`、`taskTitle`、`status:"running"`、`runtimeName`=agentId、`purpose:"development"`；新 `Run.id` 就是新 `KanbanSession.id` |
| 会话状态变化 | 该 Run 的 `status` 同步；`Task.metadata.lastActivityAt` 每次刷新 |
| `awaiting_review` / `needs_attention` | Run `status:"completed"`；`Task.execution.agent.status="completed"`（等待用户） |
| `failed` | Run `status:"failed"`；`Task.execution`：`phase:"failed"`、`status:"failed"`、`failure = { stage:"agent", code:"kanban-agent-failed", message, at }` |
| `interrupted` | Run `status:"cancelled"`；`Task.execution`：`phase:"failed"`、`failure.code = "kanban-session-interrupted"` |
| `stopped` | Run `status:"cancelled"` |
| 卡片进 Done（`trash`） | 不动 Task；Run 停在终态 |
| 卡片删除 / 清空 Done | Task 走 `TaskService.softDelete()`（回收站可恢复），**不物理删** |

`Task.execution` 每次写入都**重算一份完整对象**（`phase / status / agent / validation / publish / stages / updatedAt`），
读路径原样返回。`Task` 上 `validation`/`publish` 在阶段出现前保持既有形状，不要为了看板伪造通过。

Run 的创建必须走 `RunService`（`packages/core/src/orchestrator.ts` 的 `createRunForTask` 或等价公开方法）；
若现成方法捆绑容器启动，就在 `RunService` 上加一个最小的、只写记录的入口。不要在 kanban 里 `store.insert("runs", …)`。

---

## 三、server（`packages/server/src/kanban/*`、`app.ts`）

### 路由

- 删除 `/api/kanban/projects` 的列表/创建/改/删里**重复实现 Project 的那些**；项目列表、改名、删除一律用既有 `GET/POST/PUT/DELETE /api/projects`。
- 保留**一个**「选目录/克隆 → 建 Project」入口 `POST /api/kanban/projects`（它做的 Git 初始化问答是看板特有的），
  成功返回 `{ project }`；同样的目录判重规则（`kanban-project-duplicate`）保留。
- 新增 helper `boardProjectRoot(project)`：`source.type === "directory"` → `source.path`。
  `git` 来源的外部 Workspace 目录只能从 Workspace 记录拿（卡片会记 `workspaceId`）。
  **解析不出目录时必须抛 `DomainError("kanban-project-path-invalid")`**，不要返回假路径或空串。
- **git 来源的 Project 在看板里只复用已有的外部 Workspace，绝不按 `remoteUrl` 创建/改写目录**
  （`desiredPath` 对 git 来源是 `undefined`）。把 URL 当路径用是本轮最容易犯的错。
- 保留的看板路由路径不变：`GET /api/kanban/agents`、`GET /api/kanban/fs`、`GET /api/kanban/projects/:id/git`、
  `GET|POST /api/kanban/projects/:id/cards`、`PATCH|DELETE /api/kanban/cards/:id`、`POST /api/kanban/cards/:id/move`、
  `POST /api/kanban/cards/:id/start|stop`、`GET /api/kanban/cards/:id/session`、`POST /api/kanban/projects/:id/trash/clear`、
  `/kanban-hooks/ingest`。
- `app.ts` 里要把 `tasks` / `runs` / `workspaces` 服务传进 `KanbanService` 与 `KanbanSessionRuntime`（见下）。

### 卡片启动（`kanban/sessions.ts` 的 `start()`）

1. 取 `Project`；确保它有一个**外部 Workspace** 指向工作目录（`ownership:"external"`、`projectId`、`path = 项目根目录`），
   没有就创建。卡片建卡时就记录 `workspaceId`。
2. 首次启动：创建 Task（带完整 `execution`）+ 一条 Run；把 `run.id` 同时用作 `KanbanSession.id`。
   `runtimeId` 由 `agentId` 在 `RuntimeService.list()` 里匹配对应 harness；匹配不到抛 `runtime-not-found`。
3. 重跑/续聊：复用 `card.taskId`，只新增 Run（以及对应的 `KanbanSession` 句柄）。
4. `settleSession` / hook 改状态 / `markWorking` 都要同步写 Run + `Task.execution` + `metadata.lastActivityAt`。
5. 删卡片/清空 Done：Task `softDelete()`，`KanbanSession` 与 transcript 照旧清理。

### 归属（让侧边栏树自动落位）

`WorkspaceTaskList.folderFor()` 对**外部 Workspace**直接按 `workspaceId` 归组。所以卡片 Task 只要带
`workspaceId = 该目录的外部 Workspace id`，就会落在正确的文件夹下。**不要改 `folderFor` 的算法来救数据。**

---

## 四、web（`packages/web/src`）

- `views/Board.tsx`：项目列表改读 `/api/projects`；用 `project.board`（`workspaceType`/`defaultAgentId`/`defaultExecutionMode`）
  填看板表单默认值；卡片新形状（`taskId`/`runId`）跟改；卡片详情加「打开任务」入口（`navigate("/tasks/<taskId>")`）。
- `components/board/types.ts`：删掉 `KanbanProject`，改成 Project 的形状副本（含 `source`、`board`）。
- `components/board/AddProjectDialog.tsx`：仍调 `POST /api/kanban/projects`，返回 `Project`。
- `views/Projects.tsx`：目录来源 Project 展示目录；看板加进来的 Project 要能出现在同一列表里（已经会）。
- 侧边栏 `WorkspaceTaskList`：预期**不用改逻辑**，但要实际验证看板 Task 落在正确文件夹下；
  若发现分组不对，先怀疑数据（`workspaceId`）没写对，不要改分组算法。

---

## 五、测试

- `packages/core/src/v13.kanban.test.ts` 与 `packages/server/src/kanban.*.test.ts` 按新形状改，并补：
  卡片启动 → 产生 Task + Run → `GET /api/tasks` 与 `GET /api/projects/:id/tasks` 都能看到；重跑只加 Run 不加 Task。
- 既有断言里与「列移动 / hook / worktree / 权限 / 终端 WS」相关的行为**保持不变**，不要为了过测试放宽。
- 验收命令：`npm run typecheck`、`npm run test -w @agentfabric/core`、`npm run test -w @agentfabric/server`。

---

## 六、Lead 验收清单

1. `grep -rn "KanbanProject\|kanbanProjects" packages --include=*.ts --include=*.tsx` 在 `src` 下 0 命中。
2. 选一个普通目录 `POST /api/kanban/projects` 后，`GET /api/projects` 有该 Project，`source.type === "directory"`。
3. 建卡并 `start` 后，`GET /api/tasks` 出现该 Task（`projectId` 正确、`workspaceId` 指向该目录的外部 Workspace，
   且 `GET /api/workspaces` 里该 Workspace 的 `path` 就是那目录）。
4. 重跑同一卡片：Task 数量不变，`GET /api/tasks/:id/runs` 长度 +1。
5. 会话 failed / stopped 后，`GET /api/tasks/:id` 的 `execution` 与 Run status 如实反映（读路径不重算）。
6. 侧边栏工作区树把该 Task 挂在对应目录文件夹下；Tasks 页也能看到。
7. typecheck 全绿，core/server 的 kanban 测试全绿。


---

## 七、第二轮追加（实测后修正，2026-10-25 第二轮）

在真实运行的服务上点完「建项目 → 建卡 → start → 去任务列表打开这条 Task」后，发现契约本身有缺口。
以下是对**上文契约的修正**，实现以此为准：

### 7.1 看板项目必须就地运行（`source.workTree`）

契约原来的做法是：卡片 Task 的 `workspaceId` 指向该目录的 **external Workspace**。但一个
`directory` 来源的 Project 一旦走 Project-task 路径，`ExecutionSupervisor.startTask` 会
`createManaged({sourcePath})` **复制**一份目录，该 Task 的 Workspace 是副本，**永远不会碰用户选的目录**。
「看板卡片 = 在用户选的目录里跑」这一条就失真了。

修正：`ProjectSource` 增加 `workTree?: boolean`，**只由看板写入**（`addProject` 写 `workTree: true`）：

- `WorkspaceService.createManaged({ inPlace: true, sourcePath })` 直接把该目录当作 Workspace
  （不复制、不新建），`ownership` 仍是 `managed`（平台拥有记录），但路径就是用户的目录；
- `ExecutionSupervisor` 对 `workTree` 来源**不需要 base commit**：没有 commit 也能跑，不 pin revision；
- `ProjectService.normalizeSource` 必须把 `workTree` 从既有记录带过去，否则一次改名就会把它变成副本。

### 7.2 目录来源的 Project 在 `/detail` 上不能 500

`supervisor.taskDetail()` 原来无条件 `gitRemoteUrl(project)`，对目录来源直接抛错——
侧边栏给任何带 `projectId` 的 Task 都显示 **Lifecycle** 入口，于是看板 Task 的 Lifecycle 是死链。
修正：`TaskDetailView.source` 的 `remoteUrl` 改为可选，目录来源回 `path`，`git` 来源才回 `remoteUrl`。

### 7.3 看板 Run 必须记 `runtimeSessionRefId`

任务线程靠 `Run.runtimeSessionRefId` 判断「这条 Run 能不能 resume」。看板 Run 原来只有
`KanbanSession.nativeSessionId`，Run 上没有 ref，线程就认为它不可续跑。
修正：`KanbanService.updateSession` 在 `nativeSessionId` 变化时注册/更新一条 `RuntimeSessionRef`
（`runtimeSessions` 服务），把 `runtimeSessionRefId` 写到 Run 上；一个 Run 一条 ref，续跑复用同一条。

### 7.4 对正在运行的卡片再点 start 是幂等，不是重启

`POST /api/kanban/cards/:id/start` 在卡片已经 live 时，**未带 `restart: true`** 就必须原样返回当前会话，
不能静默杀掉正在跑的 agent 换一个新的（会丢掉进行中的那一轮）。只有显式 `restart: true` 才先 stop 再起。

### 7.5 用户主动 Stop 不是失败

`stopped` 的投影必须是 `execution.status: "running"` + `agent.status: "cancelled"` + **无 `failure`**，
否则任务线程会对一个什么都没出错的 Task 显示重试。`interrupted`（重启打断）仍然写 `failure`，
但 Run 是 `cancelled`（不是 agent 失败）。`failure` 每次投影**重新算**，不从上一次继承——
重跑之后的成功状态不能还挂着上一轮的失败。
