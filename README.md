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
                        │      Workspace (directory)      │
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
* **Workspace defines the directory. Task defines the intent. Run executes the agent. Runtime is disposable. Supervisor owns the execution lifecycle.**
* **Workspace is a directory, not a copy**：工作区就是本机上的一个目录，任务在原地执行；平台不 clone、不 checkout、不建分支、不 push。Git 写操作（commit / push）属于 harness，不属于平台。
* **Runtime is a place to run, not a property of the workspace**：同一个工作区既能用本机 harness（OpenCode / Pi / Codex / Claude Code / DSH）跑，也能用 Docker 隔离运行时跑；运行时与工作区解耦。
* **Harness sessions stay native**：AgentFabric 只保存原生 Session 的不透明引用，不统一、不转换；harness 自己的登录态与配额由 harness 管理。
* **没有 Project 层**：不存在「代码库配置 / 克隆源 / 凭据 / 分支 / publish 策略」这组概念；一个任务只需要一个目录、一个运行时和一个模型。

## 功能清单

| 领域 | 能力 |
| --- | --- |
| Provider | 增删改查、API 接口格式（OpenAI Responses / Completions / Anthropic / 兼容 / 自定义）、自定义 Base URL 与额外 Header、API Key 走 Secrets、启用/禁用 |
| Model | 增删改查、所属 Provider、参数、Alias、运行时自由选择 |
| Task Lifecycle | 单阶段：Workspace → Runtime → Agent；每个 Run 记录 phase / status，失败可按阶段重试 agent。没有 source preparing、validation、finalization、publish 阶段。 |
| Kanban | 四列看板（Backlog / In Progress / Review / Done）管理本地 Coding Agent CLI：**看板就是一个工作区**（目录，Git optional）、Card、PTY 终端会话 / DSH ACP 交互聊天、Direct / Worktree 执行、hooks 与 ACP turn 自动 Review、重启恢复；支持 Claude Code / Pi / OpenCode / DSH（ACP）。**卡片跑起来会产出一条真正的 Task**，所以侧边栏工作区任务树里能看到它 |
| Runtime | OpenCode / Pi / Codex / Claude Code / DSH / Docker / Mock，统一 Adapter 协议，可扩展 |
| Container / Sandbox | Docker 容器创建/销毁、CPU/Memory 限制、Workspace 挂载、Env/Secret 注入、网络策略、生命周期、超时 |
| Workspace | 本机目录 + 可选默认 Runtime / 默认 Model + 可选看板设置；durable，与 Run 关联。**唯一的一等实体**，任务、看板与侧边栏都读同一份记录。 |
| Task | 指定 Workspace / Runtime / Model / Env / Secrets / 资源限制 / 超时 / Policy；软删除后保留 30 天可恢复，过期物理清理 |
| Run | Pending→Starting→Running→Completed/Failed/Cancelled/Timeout，phase（workspace/runtime/agent），查看/取消/重跑 |
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

# 启动 API 服务器（默认 http://127.0.0.1:7377，自动托管 Web UI）
npm start

# 开发模式：分别启动 server 与 web（web 走 vite 代理到 7377）
npm run dev:server
npm run dev:web
```

打开 http://localhost:7377 查看 Web UI。

### macOS 桌面 App（`.app` / `.dmg`）

`packages/desktop` 把同一个 API 服务器 + Web UI 打包成 macOS App：一个 Electron 窗口，里面装的就是 `http://127.0.0.1:<随机端口>` 上的普通 Web UI，REST/SSE/终端 WebSocket 全部走真实 loopback http，和浏览器里的行为一致。

```bash
npm run desktop                        # 从源码跑窗口（不打包）
npm run desktop:app                    # 构建 .app → packages/desktop/release/mac-arm64/AgentFabric.app
npm run desktop:dmg                    # 构建 .app + .dmg
npm run desktop:dmg -- --arch=x64      # 构建 Intel 版
```

数据目录与 CLI 相同（默认 `~/.fabric`，`AGENTFABRIC_DATA_DIR` 可覆盖），所以桌面 App 直接看到终端里创建的看板、provider 和设置。服务器仍是 loopback-only，API Token 仍是 `<dataDir>/token`。启动失败时完整报错写入 `<dataDir>/desktop-startup.log`（Dock 启动没有终端）。

打包后的 App 里各部件放在哪里（都在 `Contents/Resources/`）：

| 位置 | 内容 |
| --- | --- |
| `backend/server.cjs` | 服务器单文件 bundle（`createServer` + 全部 workspace 包 + express/ws，esbuild 产出） |
| `backend/node_modules/node-pty` | 原生 PTY 模块，按 **Node ABI** 编译（`scripts/build-native.mjs`） |
| `web/` | 构建后的 Web UI（`packages/web/dist`） |
| `app.asar` | 窗口主进程 `src/main.js` |

三条约束，改的时候不要踩：

* **主进程必须是 CommonJS（`src/main.js`）。** 打包后的 App 里 Electron 根本不会执行 ESM 入口：进程起来了、窗口不出现、日志一行没有，因为脚本没有被加载。`afterPack` 与 `verify-app` 都会检查 asar 里没有 `.mjs`、`package.json` 没有 `"type": "module"`。
* **服务器跑在 Electron 主进程内，不在子进程里。** 一是它要用 `node:sqlite`；二是"从 app 里把 Electron 当 Node 子进程拉起"在 packaged app 里不可靠（app 内的 helper 用 `ELECTRON_RUN_AS_NODE` 拉起不会进入 Node 模式）。因此 `node-pty` 按 Node ABI 编译：Electron 主进程用的就是 Node 的 ABI。**升级 Electron 主版本后要重跑 `npm run desktop:app`**（`build-native` 会针对当前 Node 重新编译）。
* **`ELECTRON_RUN_AS_NODE` 会让整个 App 变成纯 Node 进程。** 如果启动环境里带着这个变量（某些自动化/IDE 的集成终端会注入），Electron 会以 Node 模式跑主脚本：没有窗口系统、拿不到 `app`。主进程启动时会清掉它；手动启动时若遇到"窗口不出现"，先检查这个变量。

构建流水线（`npm run desktop:dmg`）任一检查失败即不出包：

1. `scripts/build-native.mjs`：按当前 Node 的 ABI 编译 `node-pty`，并立刻 spawn 一次验证。
2. `scripts/smoke-pty.mjs`：用打包后的目录布局加载 bundle、起服务器、开一个看板终端会话，确认 PTY 真的 spawn 出进程并从 WebSocket 收到字节（本机没有可用的 agent CLI 时跳过该项并明说）。
3. `afterPack`：校验资源齐全、asar 入口是 CommonJS、`node-pty` 能在当前 Node 上加载并 spawn。
4. `scripts/verify-app.mjs`：按 App 的方式从打包目录加载服务器，检查首页 UI、`/api/health`、看板 API、PTY。
5. `scripts/build-dmg.mjs`：用 `hdiutil` 生成 dmg 并实际挂载校验布局（`.app` + `/Applications` 快捷方式）。

窗口本身需要 GUI 会话才能观察；`npm run desktop:dmg -- --gui-check` 会启动打包好的 App 直到它返回首页（会清掉 `ELECTRON_RUN_AS_NODE` 再启动，以免测到的是环境而不是 App）。

#### 装完之后验证界面

`npm run desktop:install` 把 dmg 里的 App 装到 `/Applications`，然后**在跑起来的 App 里**逐页验证界面——它连跑两遍，两个数据集都要过：

```bash
npm run desktop:install        # 安装，并跑下面两轮
npm run desktop:verify         # 只跑有数据的夹具：57 项
npm run desktop:verify:empty   # 只跑空数据目录（全新安装）：43 项
```

* **夹具模式**：在一个临时 `dataDir` 里写入任务、工作区、看板卡片、两条 60 消息的长线程等，覆盖交互行为（切换任务时草稿与滚动位置、看板两步删除、设置未保存保护、Docker 状态、终端空状态等）。
* **空安装模式**：不写任何数据，只看用户第一次打开时看到什么（每个页面无错误、侧栏空状态、首次使用的阻断提示指向真实存在的页面）。依赖夹具的那 8 个断言块**显式跳过**（块首有 `FIXTURE-DATA ONLY` 标记），而不是留着假装通过。

验证脚本启动 App 前会先自检两件事——这两类问题 App 内部任何断言都发现不了：

1. **`/Applications` 里的 App 是否落后于 `packages/web/dist`**：改完前端没重新打包，检查的其实是上一版代码，失败原因看起来会像"代码坏了"。
2. **`packages/web/dist` 里是否有多份构建**：两个 `vite build --watch` 同时写输出目录会让同一视图出现两份 chunk，`index.html` 指向其中一个，**页面静默空白**。

两者都只警告不中断（重建 dist 不重装是正常开发循环），但会让结论带上明确的保留条件。审查结论与已修复问题见 `docs/interaction-audit-2026-10-25.md`。

### 性能回归检查

```bash
npm run desktop:perf                # 对已打包的 App 跑一遍（需先 npm run desktop:app）
npm run desktop:perf -- --update    # 有意改动之后更新基线
```

基线在 `packages/desktop/scripts/perf-baseline.json`，当前值：

| 指标 | 基线 | 上限 |
| --- | --- | --- |
| 首屏 JS | 162 KB | 180 KB |
| 按需加载的视图 chunk | 20 | 必须正好 20 |
| 冷启动（到服务可连接） | 240–260 ms | 1500 ms |
| UI 可访问 | 290–330 ms | 1800 ms |
| 列表接口耗时 | 3 ms | 150 ms |
| Tasks 页 API 请求数 | 5 | 7 |

设计成「形状变化报警」而不是跑分：

* **体积和数量是精确判据**——视图 chunk 数必须正好 20，因为**只要 `App.tsx` 里有一个视图不再惰性加载，它就会被并回首屏 chunk**，这正是这项检查存在的理由。这条经过反向验证：故意把一个视图改成同步 import，检查立即失败并指出「19 lazy chunks, expected 20」。
* **时间类指标留足抖动空间**——同一台机器上冷启动实测会在 240–560 ms 之间波动（系统负载），所以上限设在 1500/1800 ms，只抓数量级的变化。

脚本不依赖 Playwright 或浏览器，只用 Node 内置能力启动 App、读构建产物。

### 桌面端的性能与交互

打包后的 App 与浏览器共同同一套 Web UI，因此优化对两边都生效：

* **按需加载的视图**：每个视图一个 chunk，首屏只加载外壳（侧栏 + 路由 + 健康检查）。首屏 JS 从 ~305KB 降到 ~163KB（gzip 93KB → 52KB）。Board 单独成块（xterm 约 400KB），只在打开看板时加载。
* **空闲预取**：首屏渲染后按顺序预取 12 个视图 chunk（不含 Board），点导航时内容直接切换。实测：同一份数据、同样服务下，点「Tasks」到内容出现 **约 38ms**。
* **静态资源缓存**：`assets/` 下带内容哈希的文件标为 `immutable`（一年），`index.html` 为 `no-cache`——窗口第二次启动不再重新校验每个资源。
* **窗口体验**：记住窗口大小/位置（显示器拔掉时自动丢弃越界坐标）；首帧就绪后才显示窗口（不再有白屏闪烁）；补上标准菜单（Edit/View，含开发者工具）；`before-input-event` 兜底 Cmd+C/V/X/A/Z；渲染进程在后台不降级（长任务、看板回放不会因为切到别的 App 而卡住）。
* **请求缓存**：GET 响应缓存 5 秒并共享在途请求——多个视图读同一批列表（`/api/models`、`/api/providers`、`/api/workspaces` 等）只发一次请求。实测连续切换 9 次导航：**25 次请求 → 9 次，且无重复**。任何写操作（POST/PUT/PATCH/DELETE）都会作废缓存；视图里的「刷新」按钮强制走服务器，不读缓存。
* **长列表分页**：Tasks / Runs 每页 50 条并显示「当前范围 / 总数」。实测 2000 条任务时：渲染行 2000→50、DOM 节点 36,137→1,044、重排 0.9ms→<0.01ms、JS 堆 24MB→6MB。分页而不是虚拟滚动，是因为这些行带菜单、卡片样式，页内 50 条已把 DOM 与重渲染成本压平，且无需测量/滚动锚定。
* **输入框的实时行为**：任务页的输入框 `Enter` 发送、`Shift+Enter` 换行（之前只认 Cmd/Ctrl+Enter，按 Enter 没有任何反应）；未发送的内容按任务分别存在 `localStorage`，切换任务、离开页面、重新加载都不会丢——提交成功才清除，提交失败（比如需要先做 handoff）保留原文。
* **相对时间会自动走**：列表里的「3m ago」原来是渲染时算一次就冻结（除非别的操作触发重渲染），现在由 `subscribeClock` 共享一个 30 秒定时器统一刷新——全应用一个计时器、窗口隐藏时停掉、没有订阅者时自动停止。实测：虚拟推进 5 分钟后「3m ago」正确变为「8m ago」。
* **键盘可达**：任务/项目卡片、provider 行原来只能用鼠标点（`<div onClick>`），现在可 Tab 聚焦、Enter/Space 打开，并带可见焦点环；看板卡片本就是完整的 `role="button"` + 键盘处理，这次把其余列表对齐到同一契约（共用 `clickableRow`）。实测：Tab 到达行 → 按 Enter/Space 都能打开任务，鼠标点击与行内菜单互不干扰。
* **列表内的查找与排序**：每行从 `workspaces` 列表线性查找改成一次构建的 Map；所有排序改为拷贝后排序——`sort` 是原地操作，直接排 API 缓存里的数组会让其他视图读到被改动的顺序。
* **轮询只在窗口可见时进行**：任务详情/运行详情等轮询在窗口切到后台时停止，回到前台立即刷新一次。实测：可见时每 2 秒一次、隐藏 4 秒内 0 次、回前台立刻 1 次。
* **服务端**：静态资源缓存头；发布的 bundle 不再带 sourcemap（构建时 `AF_BACKEND_SOURCEMAP=1` 可要回）。热路径实测（列表/健康检查/首页）均在 1ms 内。

签名：默认 ad-hoc/未签名（`identity: null`），没有签名证书也能出包。首次打开需要右键 → 打开，或 `xattr -dr com.apple.quarantine /Applications/AgentFabric.app`。正式分发需配好 Apple Developer 证书并去掉 `electron-builder.yml.js` 里的 `identity: null`。应用图标在 `packages/desktop/build/icon.icns`（改图标重新生成 icns 后重跑构建即可）。

网络受限环境：Electron 二进制从 `ELECTRON_MIRROR`（默认 npmmirror）下载；dmg 由 macOS 自带的 `hdiutil` 生成，不需要从 GitHub 拉 electron-builder 的 dmg 工具链。

服务器默认只监听 `127.0.0.1`（`AGENTFABRIC_HOST` 可覆盖）。所有 `/api/*`（`/api/health` 除外）都要求 Bearer Token：首次启动时在数据目录生成 `<dataDir>/token`（`0600`），浏览器通过首屏下发的 `af_token` Cookie 携带，CLI 自动读取该文件。用 `AGENTFABRIC_HOST` 绑到非 loopback 地址时服务器会打印警告——此时 API Token 是保护全部凭据的唯一屏障。

## Web UI

界面是「侧栏 + 主区域」两栏：

**侧栏就是任务入口。** 顶部是 **新会话** 按钮（主操作，整条重占一行），它下面单独一行是 **看板** 入口（`/kanban`），再下面「工作区」标题行带三个图标：搜索（跳到完整任务列表）、筛选（只看已置顶）、新建任务。列表按工作区分组：**点标题行可折叠/展开**该工作区（标题右侧显示会话数），标题悬浮时的 **···** 菜单提供「折叠 / 重命名工作区 / 删除工作区」。删除只删工作区记录：它下面的会话会移到「未归类」，会话本身不删，磁盘上的目录也不动。

每个工作区默认显示最近 6 条，下面有「展开其余 10 个会话 (剩余数)」，**每点一次多显示 10 条**，全部展开后按钮变成「收起」回到第一页。

每条会话悬浮时右侧出现 **···** 菜单：置顶 / 重命名 / 复制会话 ID / 删除会话。置顶是**本浏览器的偏好**（存在 `localStorage`），不写服务端——它只影响这台机器上看列表的顺序；重命名走 `PATCH /api/tasks/:id`（只接受 `title`，空标题与未知字段都会被拒）。

点一条会话，主区域就打开这个 Task。分组用的是 Task 自己记录的 `workspaceId`：一个工作区就是一个本机目录，看板卡片跑出来的 Task 与手动新建的 Task 落在同一个分组里；没有工作区的任务归入「未归类」。

**侧边栏顶部**：品牌行只剩名字（搜索、通知、语言切换三个图标都拿掉了，语言切换在设置里）；**折叠/展开按钮在工作区标题行的最左边**（参考 DSH：控件放在它控制的那块面板的起始处，用「一块带左侧栏的面板」图标，展开/收起同一个图标，不做旋转）。收起后整块侧边栏收成一条窄图标栏：品牌行只剩 AF 标记，任务树隐藏，**折叠按钮下方就是「新会话」按钮**（加号气泡图标，等同于展开时的整行「新会话」按钮），再往下是原来的图标导航。工作区标题行右侧的 **+** 是新建任务；下面的树按工作区分组，**工作区是文件夹**（带文件夹图标，展开时是打开态的文件夹、折叠时是闭合的，不再额外画一个下三角），它比下级的会话标题更淡、更小一级，会话名带缩进，所以「文件夹 → 里面的会话」这一层关系一眼能看出来。

**主区域只承载两件事**：打开某个 Task（对话 + 输入框），以及新建任务。其余页面收进侧栏底部的 **更多** 菜单：

* `Resources` — `Runtimes`、`Native sessions`、`Handoffs`。`Kanban` 不在这里：它在侧栏顶部、「新会话」下面有自己的入口。
* `System` — `Runs`、`Usage`、`Settings`（模型、代理等都在 Settings 里，见下）。

这些页面本身仍是独立路由（`/kanban` 等），链接和书签照常可用；`/tasks` 仍显示完整任务列表（含 Trash 入口与累计花费），只是它不再是唯一入口。侧栏折叠成图标栏时，任务树隐藏、**更多** 菜单改为向右弹出。

Agent Profiles 目前仅通过 API 与 CLI 提供，Web UI 未开放入口。

### Settings（`/settings/<section>`）

Settings 是一个带左侧导航的弹窗，按分区呈现，而不是把原始 JSON 甩给用户：

`通用设置`（含界面语言）、`模型`、`代理`、`通知`、`Harness CLI 路径`、`Docker`、`自动重试`、`关于`。导航在左侧，URL 随之变化（`/settings/proxy`），刷新或重新打开都停在同一页；旧的 `/proxy`、`/llm` 书签分别落到「代理」「模型」分区。

* **Harness CLI 自动检测**：`opencode` / `pi` / `codex` / `dsh` / `claude` 五个 CLI 的路径默认**自动检测**，配置文件里对应的 `bin` 留空即可。检测不是 `which`——macOS 上从 Dock 启动的 App 拿到的是 launchd 的 `PATH`（只有 `/usr/bin:/bin:/usr/sbin:/sbin`），npm、bun、nvm、pnpm、asdf、mise、Homebrew 装的 CLI 全都不在里面，于是「装了五个 agent」的机器会被告知「本机没有安装任何 agent CLI」。检测按四条规则依次找，命中即止：

  1. **显式指定**：环境变量 `AGENTFABRIC_<NAME>_BIN` 优先于配置文件里的 `bin`；显式指定的路径**不会被猜**——路径不存在就报错说明，不会悄悄换一个二进制；
  2. 服务器进程自己的 `PATH`；
  3. **包管理器/版本管理器的安装目录**（`~/.local/bin`、`~/.npm-global/bin`、`~/.npmrc` 的 prefix、`~/.bun/bin`、`~/.volta/bin`、`~/.asdf/shims`、mise/fnm/nvm 的 Node 目录、`~/.opencode/bin`、Homebrew 等；nvm 取 `alias/default` 那个版本，没设则取最高版本）。启动时这些目录会**追加到进程 PATH**，所以看板 PTY、Run 的 harness、docker 客户端解析到的都是同一个二进制；
  4. **登录 shell 的 `PATH`**：用 `$SHELL -ilc`（失败再 `-lc`）问一次，覆盖 `nvm use`、自定义 prefix 这类固定清单猜不到的目录；答案缓存一分钟，超时不影响请求。

  设置页每个 CLI 下面显示检测到的**绝对路径 + 版本 + 来源**，找不到则显示「未找到」。CLI 装在一个**终端 `PATH` 里没有的目录**时会额外标注——这正是「我明明装了，终端里 `which` 却找不到」的情形。看板的新建任务表单同样用这套检测：chip 的可用性、启动时用的二进制都来自它，所以不会因为 App 的 `PATH` 不同而把已安装的 CLI 判成未安装。`GET /api/harness/clis?refresh=1` 丢弃缓存重新检测（运行期新装的 CLI 用得上）。

* **模型也在配置文件里**：`providers` 段就是供应商与模型的声明，形如

  ```json
  "providers": [
    {
      "id": "my-gateway",
      "name": "My gateway",
      "type": "openai-completions",
      "baseUrl": "https://llm.example.com/v1",
      "apiKey": "sk-…",
      "models": [{ "name": "gpt-4o", "alias": "4o", "parameters": { "temperature": 0.2 } }]
    }
  ]
  ```

  模型 id 由名字推出（`mod_gpt-4o`），所以在文件里改一个模型的名字与在界面上改名是同一件事，引用它的 Task / Runtime 也仍然指向同一个模型。密钥有两种放法：写在本文件的 `apiKey`（文件 `0600`，用户能直接读）或放在 AgentFabric 加密的 Secret store 里并用 `apiKeySecretId` 引用——在界面上填的 Key 一律进 Secret store，文件里只记引用，不会把密钥抄一份到文件。API 永远不返回密钥本身，只返回掩码（`apiKeyMasked`）。
* **两个方向都同步**：在「模型」页保存（新增/修改/删除供应商与模型）会立刻重写文件的 `providers` 段；手工改这段再「应用并重启」会按文件重建列表——文件里没有的供应商就是被删除了。

* **界面语言**：中文 / English 两套文案，在「通用设置」里切换（侧边栏顶部不再有这个按钮，只为这个用途留一个图标不值得占位置）。选择存在浏览器 `localStorage`，只影响这个浏览器；服务端配置里不放语言项。文案表在 `packages/web/src/i18n.ts`：中文是键集合的事实来源，英文缺键是编译错误，不会静默回落到另一种语言。**界面上所有用户看得见的文字都在这张表里**——页面、弹窗、表头、按钮、tooltip、占位符、空状态，以及状态/阶段枚举的显示名（枚举值本身不变，只换显示文字）、相对时间（“3 分钟前”）和工具调用动词（“读取 / 执行”）。不翻译的只有标识符类内容：模型名、provider 名、runtime kind、路径、错误 code 和用户自己的数据。新增界面文案时请直接加键，不要把英文写死在组件里——漏掉一处，中文界面里就会出现一句英文。
* **配置文件**：所有设置都落在一个文件里——`<dataDir>/config.json`（默认 `~/.fabric/config.json`，`0600`）。页面顶部是「打开配置文件」：在宿主机默认文本编辑器里打开它（macOS 用 `open -t`，绕开 `.json` 的关联程序）。文件顶部带 `$schema: /api/settings/schema`，编辑器据此补全键名并显示每个字段的说明；该 schema 端点不需要 token（它是格式描述，不含用户数据），否则编辑器拿不到。
* **手工编辑怎么生效**：页面上的表单保存后立即写入文件；手工改文件后，文件卡片会显示「文件已在磁盘上修改，但尚未应用」，点 `应用并重启` 才生效（`POST /api/settings/apply`）。重启是**原地重启**：同一个进程内拉起一个新的服务器实例，所以 `npm start` 这种没有看守进程的启动方式也能恢复；桌面端等同理（只换服务器，不动窗口）。
* **文件坏了不会把服务带崩**：正在运行的服务不会因为配置文件暂时不合法而退出——文件卡片显示解析错误，运行中的配置保持不变，`应用并重启` 被禁用。只有在服务**启动时**配置文件不合法，才会拒绝启动（带上错误信息）。
* **只有一个写入者**：`GET/PUT /api/config` 与「应用」都会把整份结果写回文件；启动时只有当文件不存在才创建它，已存在的文件不会被启动流程改写，因此编辑器里未保存的改动不会被覆盖，「revision 一致/不一致」也才有意义。
* **保存是合并**：`PUT /api/config` 以**磁盘上现有的键**为底，替换请求里给出的分区，其余分区原样保留；`server` 分区由启动流程拥有（记录本次实际绑定的地址），保存不会改动它。读侧投影（`urlSet`、脱敏后的 webhook）永远不会被当成设置写回文件。

### Kanban（`/kanban`，v13）

看板不另建一套实体：**一个看板工作区就是一个 `Workspace`**——`path` 指向用户选定的本机目录（folder-first，不要求 Git；自动识别 `none` / `git` / `multi-git` / `google-repo`，识别结果与看板的默认 agent / 执行模式一起存在 `Workspace.board` 里），一张 **Card** = 一段 prompt + 一个 agent + 执行模式。页面左侧是工作区列表（和侧边栏「工作区」是同一份记录），右侧是固定四列：

* **卡片就是 Task**：卡片第一次启动时创建一条**真正的 Task**（`workspaceId` = 该目录的工作区），每次启动是这条 Task 的一个 **Run**；续聊（`--resume` / ACP `session/resume`）复用同一个 Run。因此看板里跑起来的活儿和其它 Task 没有区别：侧边栏**工作区任务树**里按目录分组能看到它，点进去就是普通的 Task 线程（`/tasks/<id>`），**任务线程里直接显示该卡片的终端 / ACP 聊天输出**（和看板卡片详情是同一个会话），看板卡片详情里有 **Open task** 入口，任务页也有 **Board card** 回到看板。
  * **就地运行**：Task 的 Workspace 就是那个目录本身，平台**不复制**一份（`workspaceId` 指向的 Workspace，`path` 就是你的目录）。这也是任务树能把它归到那个文件夹下的原因。新建任务与看板走的是同一条执行路径。
  * **一个目录只有一条 Workspace**：如果这个目录已经是普通工作区（侧边栏里挂着它的历史会话），看板沿用**那一条**并把 `board` 设置写进去，不再新建第二条同名记录——两个同名目录会让看板的 Task 落在用户没在看的那个分组里。这条规则由 `WorkspaceService` 自己守着，不只看板：`POST /api/workspaces`、`/api/workspaces/import` 与改 `path` 的 `PUT` 遇到已被占用的目录都返回 `409 workspace-duplicate`，消息里给出**已有那条**的 id 与名字。侧边栏按 `workspaceId` 分组，同一目录两条记录就会显示成两个同名分组。
  * **Stopped ≠ Failed**：在卡片上按 Stop 只会把 agent 标成 `cancelled`，任务不会出现失败徽章或重试按钮；服务重启打断的会话才写 `failure`（Run 仍是 `cancelled`）。对**正在运行**的卡片再点 start 是幂等的，不会悄悄换掉正在跑的 agent（要换会话请用 restart）。
  * 状态映射（写入时投影，读取不重算）：会话 `running` → Run `running`；turn 结束（`awaiting_review` / `needs_attention`）→ Run `completed`，Task 仍是 `running` 且 `execution.agent.status = completed`（等你）；`failed` → Run `failed` + `execution.failure.code = kanban-agent-failed`；服务重启中断 → Run `cancelled` + `kanban-session-interrupted`；`stopped` → Run `cancelled`。`validation` / `publish` 永远是 `pending`——看板不跑判定也不 publish，不会伪造通过。
  * 看板不物理删除历史：删卡片（含「清空 Done」）只把 Task 软删除（回收站 30 天可恢复）并删掉进程句柄与聊天记录，工作区目录与 Run 历史都留着。
* **看板工作区与侧边栏是同一份记录**：`GET /api/kanban/workspaces` 只返回带 `board` 设置的工作区；「选目录 → 添加」走 `POST /api/kanban/workspaces { rootPath }`（不 clone、不 `git init`），改名与删除都用通用的 `/api/workspaces/:id`。

* **列与拖拽**：`Backlog` / `In Progress` / `Review` / `Done`（内部 id `trash`）。`Backlog → In Progress` = 启动；任意列 → `Done` = 归档并**释放进程**（不长期占用资源）；`Done → Review` = 恢复，再次启动时用 harness 自己的会话 id 接回原对话（Claude 走 `claude --resume <id>`，DSH 走 ACP `session/resume`）；`In Progress ↔ Review` 由 session 状态自动驱动，用户拖拽会被拒绝。没有 resume 能力的 agent（如 Pi）归档时保留进程，否则会丢掉唯一的对话记录。
* **Done 列**：与 Cline kanban 一致——列头带红点、计数与垃圾桶按钮（清空 Done：删卡片、进程句柄与聊天记录，并把各自的 Task 软删除进回收站；不动工作区目录、worktree 与 Run 历史）；Done 卡片标题与工作目录划线置灰，右上角 `↺` 一键恢复回 Review，不显示会话状态徽章。
* **新建看板工作区**：`Add workspace` 打开对话框，只有 **Server path** 一种入口（服务端目录自动补全：逐级浏览本机目录，条目标注是否为 Git 仓库，支持 `~` 与直接输入绝对路径）。工作区名默认取目录名；同一个目录不能重复添加。没有克隆入口，也不会 `git init`——目录里有没有 Git 是目录自己的事。
* **新建 Card**：Backlog 列顶部 **Create task**（快捷键 `c`）或页面右上 **New task** 打开创建对话框：prompt、可选标题（留空时从 prompt 首句自动生成）、Agent（Claude Code / Pi / OpenCode / DSH）、Model、Permission mode、Workspace（Direct / Worktree）与 Worktree base ref（列出项目的本地分支，默认当前分支）。`⌘/Ctrl+Enter` 创建，`⇧⌘/Ctrl+Enter` 创建并立即启动；勾选 **Create more** 时创建后对话框保留以便连续录入。一段编号或项目符号列表可 **Split into N tasks** 批量创建 / 批量启动。对话框用该工作区上次的选择（agent / model / permission / workspace / base ref）预填；侧栏第一行用 `git` 标记 Git 目录（非 Git 不显示），路径下方用 `B | 1` / `IP | 1` / `R | 1` / `D | 1` 徽章显示四列卡片数（对齐 Cline kanban）。
* **编辑 Card（对齐 Cline kanban）**：点击 **Backlog** 卡片打开的就是创建它的那张表单，字段预填卡片当前值（prompt / 标题 / agent / model / 推理强度 / 权限 / Workspace / base ref），只有一个 **Save changes** 动作（`⌘/Ctrl+Enter` 或点击保存，`Esc` 关闭），没有 Split 与 Create more；保存后卡片原地更新。其他列的卡片点击仍是详情（会话、终端 / 聊天、元信息）——卡片一旦离开 Backlog，prompt 与 agent 就是 agent 实际执行过的输入，看板不再改写这段历史；服务端同样只允许改动 Backlog 卡片（`kanban-card-not-editable`）。编辑过程中卡片若被启动、拖走或删除，表单自动关闭。
* **实时性**：看板自行保持近实时——卡片与各会话状态每 2s 轮询，工作区列表与四列计数每 5s 刷新，切回标签页时立即补拉一次；因此页面上没有手动 refresh 按钮。
* **卡片详情布局**：任务信息（Prompt + 元信息）默认折叠成左侧一条竖向细栏（`DETAILS`），点击展开；展开后与右侧会话面板（终端或 ACP 聊天）之间的分隔条可拖动调整宽度比例（宽度记在浏览器本地），面板上下不留空白、占满整个高度；左上角 ← 返回看板。
* **本地 PTY**：用 `node-pty` 直接启动本机 Claude Code / Pi / OpenCode，卡片详情内嵌 xterm 终端，可输入、resize、stop / restart；关闭详情只是 detach，重新打开时服务端回放整段会话历史（不自动重连）。回放不是重放原始字节，而是服务端用 `@xterm/headless` 实时跟着 PTY 解析、attach 时用 `@xterm/addon-serialize` 把当前屏幕 + 最多 1 万行 scrollback 一次性序列化下发——TUI 是绝对定位重绘的，只有这样才能还原出可以往上翻的完整历史（旧实现是 256KB 字节环形缓冲，超了就从头部截断，会切碎转义序列、只能看到碎片）。
* **DSH（ACP 聊天）**：DSH 自带的 surface 没有交互 TUI（社区另有独立的 dsh-tui 启动器，看板仍选 ACP 以便结构化展示消息 / 工具 / 权限并复用 session/resume）。每张运行中的卡片起一个 `dsh --profile acp` 进程（ACP / Agent Client Protocol stdio），prompt 通过协议发送而不是 argv。卡片详情是 AgentFabric 自己渲染的聊天：assistant 消息（Markdown）、Thinking（默认折叠）、工具调用（状态点，可展开 input / output / error）、权限卡片与 composer；一个 turn 结束进程不退出，可以继续追问。聊天 WS 是 `GET /api/kanban/sessions/:sessionId/agent`（与终端 socket 同一套 `af_token` / loopback 规则，JSON 文本帧），关闭详情同样只是 detach，重新打开 replay 服务端保存的聊天记录（不自动重连）。聊天记录按 session 落盘在 `dataDir/kanban-chats/<sessionId>.json`（流式时防抖、turn 结束 / 权限 / 进程退出 / 服务端关闭时立即写），因此重启后仍能查看。
* **DSH 续跑 / 像 TUI 一样直接输入**：进程消失（服务端重启、Stop、agent 退出）后打开卡片，聊天会 replay 已保存的记录，状态显示 **paused**。**输入框照常可用**——直接打字发送时，服务端先接回 agent（ACP `session/resume {sessionId, cwd}`，同一个会话、同一份模型上下文），再把这条消息作为新 turn 发出去；这与 TUI / DSH Desktop「停下后继续打字」的体验一致。也可以点 **Resume now** 先接回、再慢慢输入。接不回时明确报错（`kanban-session-resume-failed`），不静默换成新会话；没有可续跑的会话记录（极老的卡片）时，发送会起一个新会话并在聊天里说明。
* **执行模式**：Direct（直接在工作区目录运行）或 Worktree（`git worktree add --detach <baseRef>` 切出独立工作树，源工作树不受影响）。每张 Worktree 卡片可指定 **base ref**（本地分支 / tag / commit，缺省 `HEAD`），仓库里不存在的 ref 会以 `base-ref-not-found` 明确失败。Worktree 只对「工作区根自己就是 Git 仓库」的看板工作区开放；非 Git / multi-git / google-repo 只能用 Direct。**不实现** isolated 目录拷贝或 Docker 隔离，worktree 就是第一期的隔离手段。
* **并发**：同一个看板工作区允许多个 Direct 会话并行，平台不加写者锁；并发写冲突由 agent 自己处理（用户明确接受这一点）。
* **状态流转**：Claude / OpenCode 通过 harness hooks 自动流转——`Stop` / `session.idle` → 卡片进 Review（PTY 保持可交互），`UserPromptSubmit` / `busy` → 回 In Progress，权限审批或提问弹卡 → **卡片移到 Review** 并标 Needs Attention（等你回答，不会被当成已完成）。Claude 弹卡片等回答时 turn 还没结束（`Stop` 要等用户答完才触发，AskUserQuestion 也不发 `Notification`），所以是 `PermissionRequest` 把卡送进 Review；你答完后卡继续工作、`Stop` 再把它送回 Review 转成 awaiting_review。用户往 Review 卡片的终端里输入也会自动回 In Progress。DSH 走 ACP，不需要 hooks：一个 turn 以 `end_turn` 或 `cancelled` 结束即进 Review（**进程不退出**），在聊天里发新 prompt 就回 In Progress。Pi 没有 hooks，用卡片详情的 **Mark for review** 手动兜底（所有 agent 都保留该按钮）。
* **DSH 模型与推理强度**：模型不由 argv 指定，而是 ACP 的 `model` config option。可在 **新建 Card** 时填模型（写 `deepseek-v4-pro`、`DeepSeek-V4-Pro` 或直接的 `["provider","model"]` 都行）并选推理强度，服务端在第一次 turn 前用 `session/set_config_option` 应用；卡片详情显示会话**实际**所在的 provider / model / reasoning effort。**聊天顶栏**有两个下拉：模型（按 provider 分组，选项来自 DSH 的实时目录）与推理强度，随时切换、对下一个 turn 生效，并广播给同一会话的其他标签页；在右侧还能看到上下文 token 用量。填了 DSH 不提供的模型会明确失败（`kanban-agent-model-unavailable`），不会静默回落到默认模型。
* **DSH 权限模式**：`Ask` 时 ACP 的 `session/request_permission` 会以允许 / 拒绝卡片插进聊天、session 标为 `needs_attention`，答完回 `running`；`Auto-approve`（risky）直接选 ACP 给出的 allow 选项、不打断对话（没有 allow 选项时仍会询问）。
* **重启恢复**：服务端退出后所有非终态 session 标记为 `interrupted`，卡片保留原列，用户可 restart；不自动重跑 agent。DSH 的聊天记录与 `nativeSessionId` 都已持久化：重启后旧卡片仍可打开查看完整对话，并用 **Resume session** 接回原会话（见上一条）；**Start new session** 则是全新会话（旧 session 记录与聊天文件保留到卡片被删除）。
* **边界**：看板 agent 作为宿主机子进程运行（PTY 或 ACP stdio），不经过 Docker 隔离运行时；实现原理见 `docs/kanban-dsh-acp.md`；第一期没有 diff / review / commit / PR、依赖链与 auto-review。完整规格见 `specs/v13.md`。

### New task（`/new`）：工作区 + 运行时

侧栏的 **New task** 只有一种模式：选一个工作区（本机目录），选运行时与模型，写清楚要做的事。

* **工作区**：下拉列出所有工作区；旁边 **＋ 新建工作区** 直接在本页填绝对路径创建并选中，不用跳到别的页面。
* **运行时**：`/api/runtimes?usableInTask=true` 全量列表——本机 harness（OpenCode / Pi / Codex / Claude Code / DSH）与 Docker 隔离运行时并列可选，不按隔离级别过滤；工作区决定挂载哪个目录，运行时决定 agent 进程跑在哪。
* **模型**：harness-native 运行时显示「使用 harness 账号」（它用自己的登录态与默认模型），其余走模型列表。
* **默认值**：工作区上的 `runtimeId` / `modelId` 是新任务的默认值，切换工作区会重新解析；用户手动选过之后以手选为准。
* **提交**：`POST /api/runs`，任务直接在 `workspace.path` 里原地执行。没有 Base ref / Working branch / Branch mode / Validation 这些输入项。

创建后落在 **Task Thread**（`/tasks/:id`）：创建完就看到 Agent 在跑，而不是先看到一张状态表。

### Task Lifecycle（`/tasks/:id/lifecycle`）

Task Detail 页面回答「Agent 现在跑到哪了」：Workspace（名字与路径）、Runtime、Current Phase、Agent 状态、Run 列表，以及可用的 Retry agent 与 Cancel。没有 Project / Source / Base Ref / Working Branch / Validation / Publish 这些行——它们随 Project 实体一起删除了。运行中每 2 秒自动刷新。

Tasks 列表不再显示 working branch 与 validation / publish 状态。

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
* **恢复入口（Tasks 页头部的 Trash）**：Tasks 页顶部在有已删除任务时显示 **Trash (N)**，点击进入 `/trash`（Deleted tasks 页），每条可 **restore**——清除 `deletedAt` 后 Task 连同全部历史回到 Tasks 页。
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
| `keep-alive` | Run 结束后容器保留 `idleTimeoutMs`（默认 10 分钟），期间同 Runtime+Workspace 的下一个 Run 通过 `docker exec` 复用；空闲超时自动销毁。重启后从**持久记录**恢复剩余窗口：取最新使用该容器的 Run 的结束时间 + 它的 lifecycle idle timeout（label 创建后不可变、复用容器仍带首次创建的 Run，只用于识别身份，不作为时间来源）；没有已结束 Run 背书（进程死于 Run 中途）或最新 Run 是取消/超时的容器直接销毁，绝不交给后续 Run 复用（v4 §24）。恢复只处理 `agentfabric.task` 指向本部署已知 Task 的容器——`docker ps` 是 daemon 级的，共享 daemon 上其他部署的容器既不收养也不销毁 |
| `persistent` | 长期存活容器（Daemon 场景），容器不被销毁 |

生命周期属于 **Task**，在创建 Task 时选定，此后**不可修改**：该 Task 的每一个 Run（首轮、continue、retry、handoff）都继承同一个策略，不存在中途漂移。它既不是 Runtime 的属性（同一个 Runtime 服务需求不同的 Task），也不是按 Run 的覆盖项（下一轮悄悄换回另一种策略，正是这个模型要消除的意外）。

创建时未指定即 `ephemeral`，该决定在创建那一刻固化到 Task 记录上（`taskLifecycle()`），Run 创建时原样拷贝一份快照——因此没有任何读取路径需要推导、兜底或修补这个值。

`GET /api/containers/kept` 与 `af containers kept` 可查看 keep-alive 保留中的容器。

### Workspace

Workspace 是持久、Runtime-neutral 的一等资源，**就是一个本机目录**（`path` 为绝对路径），不是 Runtime Container，也不是平台生成的副本。

* **Create / Import**：新建空目录，或导入已有本地目录（`POST /api/workspaces`、`/api/workspaces/import`）。
* **Defaults**：可选 `runtimeId` / `modelId`，作为新任务的默认运行时与模型；任务可覆盖。
* **Attach**：Run 时挂载进容器（Docker 运行时）或作为进程 cwd（本机 harness）。
* **Save**：Run 结束后校验并记录 `lastSavedAt` / `lastSavedRunId`；目录消失时 `status = "missing"`。
* **Usage**：`GET /api/workspaces/:id/usage` 查看被哪些 Task/Run 引用。
* **Lock**：同一个 Workspace 同一时刻只有一个 active writer；`GET /api/workspace-locks` 可查看当前持有的锁。

### Task：从工作区创建任务

创建 Task 只需要三个决定：

```text
Workspace                 （本机目录；任务在那里原地执行）
Task Instruction
Runtime / Model           （可选覆盖工作区的默认值）
```

没有 Base ref / Working branch / Branch mode：平台不 clone、不 checkout、不建分支，也不 push。Git 写操作（commit / push）由运行任务的 harness 自己决定，AgentFabric 不参与。

### Workspace：本机目录

**Workspace 就是本机上的一个目录**，不是托管副本，也不是 Runtime Container。

* **唯一一等实体**：`path` 是绝对路径，`name` 是显示名；可选 `runtimeId` / `modelId` 作为新任务的默认值，可选 `board` 保存看板设置。没有 `projectId` / `ownership` / `workingBranch` / `baseCommitSha`。
* **原地执行**：Task 的 `workspaceId` 指向它，agent 进程的 cwd 就是 `path`。平台不复制、不接管、不删除这个目录。
* **Durable**：Runtime Container 生命周期 ≠ Workspace 生命周期。容器可随时销毁重建，目录与其中未提交的修改始终保留。
* **Workspace Lock**：同一个 Workspace 同一时刻只有一个 active writer。第二个写入者拿到 `workspace-locked`，而不是让两个 Run 同时改同一棵目录；锁在 Run 结束/取消时释放。

### Run：一个 Task 可以拥有多个 Run

一个 Task 可以执行多个 Run，这些 Run 共享同一个 Task Workspace：Runtime 重启、Handoff、Harness 切换、Agent 失败、用户重新执行都会产生新的 Run，而 Workspace 中的文件改动持续存在。

Run 保留粗粒度 `status`（Pending → Starting → Running → Completed / Failed / Cancelled / Timeout），并记录细粒度 `phase`：

```text
task.created → workspace.preparing → runtime.preparing → agent.running → cleanup → completed / failed / cancelled
```

### Runtime：disposable execution environment

Runtime 是**可销毁的执行环境**。每次 Run 按 **Task 的 lifecycle 策略**创建容器（默认 `ephemeral`：Run 结束即销毁；策略在创建 Task 时选定，见「容器生命周期」）。Workspace 与 Runtime Native State 以挂载方式注入。

Runtime 声明自己的 **execution backend**（`executionBackend: "isolated" | "host"`，旧记录由 `containerized` 推导）。它描述执行位置（容器内 / 宿主机），UI 与诊断读它；任务不按隔离级别做准入判断，本机 harness 与 Docker 运行时都可执行同一工作区。容器销毁不会影响 Workspace，也不会影响 Harness 的 Native Session。

### Supervisor：execution lifecycle 的负责人

`ExecutionSupervisor`（`packages/core/src/supervisor.ts`）位于 **Control Plane**，负责一次 Run 的执行：

* **Workspace lifecycle**：prepare / lock / attach / preserve / cleanup；
* **Runtime lifecycle**：create / monitor / timeout / stop / cancel / destroy；
* **Runtime provisioning**：Harness / Agent / Model / environment / Native State mount / Workspace mount；
* **Execution monitoring**：process exit、heartbeat、stdout-stderr、结构化事件、cancellation、timeout；
* **Stage recovery**：崩溃重启后按 crash 时的阶段恢复，不倒退已完成的阶段。

Source（clone / fetch / checkout / branch）、Credential、Finalization、Publish、Validation 这些职责随 Project 实体一起删除。Runtime Container 内只运行 Agent Harness（Runner 侧只做启动、信号转发、输出与结构化事件转发、退出码上报）；Git 操作由 harness 自己完成。

### Cancellation

用户随时可以取消正在执行的 Task / Run（`POST /api/tasks/:id/cancel`）：终止 Runtime 进程、进入 cleanup、**Workspace 保留**（当前文件修改不删除）、释放 Workspace lock、Task 状态准确记为 `cancelled`。之后可以基于同一个 Workspace 继续新的 Run。

### Task Detail / 可观测性

`GET /api/tasks/:id/detail`（Web UI 的 `/tasks/:id/lifecycle`、`af tasks detail <id>`）展示：

```text
Workspace（名称与路径）
Runtime
Current Phase
Agent Status
可用的 Retry（agent）与 Cancel
```

每次 Task / Run 都能追踪：Workspace、Runtime、Harness、Model、Run phase、起止时间、exit result；生命周期关键操作写入 Event / Logging 系统（`run.phase`、`workspace.prepared`、`runtime.prepared`、`task.recovered` 等）。

### 领域错误模型

失败带稳定 `code` 与 `stage`，API 按 stage 映射 HTTP 状态：

```text
Workspace     workspace-create-failed · workspace-locked · workspace-invalid · workspace-not-found
Runtime       runtime-create-failed · runtime-start-failed · runtime-lost · runtime-timeout
              runtime-not-usable
Agent         agent-start-failed · agent-failed · agent-timeout · agent-cancelled
Platform      task-not-found · task-state-invalid · task-busy · policy-denied · supervisor-restarted
              config-invalid · invalid-request
```

HTTP 映射：授权/策略类为 **403**；并发/状态冲突类（`workspace-locked`、`task-busy`、`task-state-invalid`）为 **409**；`runtime-*` 为 **502**；`config-invalid` / `invalid-request` 为 **400**。

### API

```text
Workspace
  GET    /api/workspaces                   列表
  POST   /api/workspaces                   创建（name, type, path, runtimeId?, modelId?）
  POST   /api/workspaces/import            导入已有目录
  GET    /api/workspaces/:id               详情
  PUT    /api/workspaces/:id               更新（含看板设置 board）
  DELETE /api/workspaces/:id               删除记录（不动磁盘目录）
  GET    /api/workspaces/:id/usage         被哪些 Task/Run 引用

Task lifecycle
  GET    /api/tasks/:id/detail             Task Detail 读模型
  POST   /api/tasks/:id/cancel             取消（终止 Runtime，Workspace 保留）
  POST   /api/tasks/:id/retry-run          新 Run 继续同一 Workspace
  GET    /api/workspace-locks              当前持有的 Workspace 写锁
```

`GET /api/dashboard` 的 `counts` 只包含 tasks / runs / workspaces 等现存实体；Project 与 Source Credential 相关端点随实体删除。

### Handoff 兼容

Task 支持既有 Handoff / Native State / Resume：Workspace 表示**用户代码与 working tree state**，Native State 表示**Harness 私有 session state**，二者不混。本期实现没有改动 Handoff 的生成、投影与渲染路径。



AgentFabric 只保存 Harness 原生 Session 的不透明引用（`RuntimeSessionRef`：Runtime 类型/版本、native ref、是否可 Resume、执行后端、metadata），不理解更不转换其内部结构。同 Harness 继续走 **Resume**，跨 Harness 继续走 **Handoff**。

* **Runtime Native State**：Harness 用于 Native Resume 的私有状态（Session 存储、内部数据库等）由 AgentFabric 以 Opaque 目录持久化（Create / Mount / Preserve / Reattach / Delete），与 Workspace 严格区分——Workspace 是用户的工作内容，Native State 是 Harness 的私有数据。默认落在 `~/.fabric/native-state/<runtimeId>`，按 Harness 挂载到容器内对应路径（OpenCode `/root/.local/share/opencode`，Pi `/root/.pi`，可用 `runtime.config.nativeStateMountPath` 覆盖）。
* **Resume**（同 Harness）：`continueTask` 优先用存储的 native ref 恢复 Harness 自己的 Session（本地与容器化执行语义一致）。自动 Resume 需要 **Same Harness × Same Workspace × 有效 RuntimeSessionRef × Native State 真实存在 × 当前执行方式下能力成立**；不满足时不会自动降级，需要显式 Handoff 才能开新 Session。
* **Continue 的默认目标 runtime**：显式指定 > **最近一次 run 的 runtime** > task 创建时的默认 > 第一个启用的 runtime。中途换过 Harness 的 task，不带目标的「继续」落在最近干活的 Harness 上。预览（`continue-options`）与实际决策（`pickTargetRuntime`）保持同一顺序。**只有隐式回退可以降级**（最近一次/创建时的 runtime 已被删除时才落到第一个启用的 runtime）；**显式指定的 runtime 解析不到时明确报错**（`runtime-create-failed`，502），绝不静默换一个 harness 执行——那会让「继续」跑在用户没有选择的 runtime 上。
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
| `dsh` | 本地 + 容器 | harness-native（DeepSeek 账号） | `--session-id <id>`（受限，见下） |
| `docker` | 容器 | — | — |
| `mock` | 本地 | — | — |

OpenCode / Pi / DSH 本地适配器依赖本机已安装的 CLI（`AGENTFABRIC_OPENCODE_BIN` / `AGENTFABRIC_PI_BIN` / `AGENTFABRIC_DSH_BIN` 可覆盖；OpenCode 适配器面向 **v2** CLI，本地装 1.x 会因未知 flag 失败）。**三个容器化 Runtime 都必须显式配置镜像**（`runtime.image`，或用 `AGENTFABRIC_OPENCODE_IMAGE` / `AGENTFABRIC_PI_IMAGE` / `AGENTFABRIC_DSH_IMAGE` 覆盖），未配置时**拒绝启动**并提示契约——参考镜像见 `docker/` 下的三个 Dockerfile，一次构建全部：

```bash
bash scripts/build-harness-images.sh            # 或只构建一部分：… opencode / … pi / … dsh
af runtimes add "OpenCode (containerized)"  --kind opencode --isolated --image agentfabric-opencode:latest
af runtimes add "Pi Agent (containerized)"  --kind pi       --isolated --image agentfabric-pi:latest
af runtimes add "DSH (containerized)"       --kind dsh      --isolated --image agentfabric-dsh:latest
```

镜像默认以 ENTRYPOINT 为 harness；无 entrypoint 的镜像可设 `runtime.config.containerCommand`。

**容器化 Harness 的认证在容器内解析，与宿主无关**：宿主是否装了 CLI、是否登录过，不决定容器里的 Run 能不能跑（宿主侧的可用性探测只作用于本地执行）；容器缺凭据时由 Harness 自己在 Run 内报错（DSH 报 `MISSING_CREDENTIAL`）。因此容器化 Runtime 的凭据要么预置进它挂载的 Native State，要么通过 Runtime env / Secrets 注入。

## 容器化 Runtime 镜像

`docker/` 下的 Dockerfile 是各 Harness 的参考镜像，都满足同一条 **Harness Execution Contract**（`docs/harness-image-contract.md`）：Harness CLI 已安装、ENTRYPOINT 就是 Harness、Workspace 挂到 `/workspace`、Native State 挂在各自约定路径、stdout 输出该 Harness 的协议、Native Resume 参数可用，以及 **python3 与 curl 可用**。

| 镜像 | Kind | Native State 挂载点 | 说明 |
| --- | --- | --- | --- |
| `agentfabric-opencode:latest` | `opencode` | `/root/.local/share/opencode` | `docker/opencode.Dockerfile`；派生自官方 v2 镜像 |
| `agentfabric-pi:latest` | `pi` | `/root/.pi` | `docker/pi.Dockerfile`；无官方镜像 |
| `agentfabric-dsh:latest` | `dsh` | `/root/.dsh` | `docker/dsh.Dockerfile`；无官方镜像 |

**为什么 OpenCode 也要自建**：官方镜像 `ghcr.io/anomalyco/opencode` 是只带 ripgrep 的极简 Alpine 构建，**没有 python3 也没有 curl**，不满足契约第 7 条。`docker/opencode.Dockerfile` 从它派生，只 `apk add python3 curl`，ENTRYPOINT 与其它一切都不动。

**OpenCode 基础镜像钉在 v2**（`ARG OPENCODE_BASE=…:2.0.26`）：`latest` 标签至今仍解析到 1.19.0，而 Adapter 面向 v2 协议——`--variant` 已被删除（variant 改为 `-m provider/model#variant`），且 `run` 会拉起后台常驻进程并缓存首次读到的配置（每个 Run 因此带 `--standalone`）。用 `latest` 构建出的 v1 镜像与 Adapter 不匹配，故 Dockerfile 显式钉版。基础镜像用 `--build-arg OPENCODE_BASE=<镜像>` 可换（内网 mirror 或更新到已验证的 2.x tag）。

```bash
bash scripts/build-harness-images.sh            # 构建 pi + dsh（AGENTFABRIC_IMAGE_TAG_PREFIX 可改前缀）
```

`docker/dsh.Dockerfile` 有两个 DSH 特有的取舍，改动前值得先读：

* **镜像里不预置 profile**。DSH 把 `$DSH_HOME/profiles/<name>` 与 sessions、credentials 放在同一个 home 下，而 AgentFabric 把整个 `/root/.dsh` 当作该 Runtime 的 Opaque Native State 挂进去——镜像里烤进去的 profile 目录每次 Run 都会被挂载遮蔽。DSH 会在首次使用时自行重建缺失的 headless profile，且 headless bundle 从全局安装解析，所以构建期不需要（也不该）执行 `dsh plugin add`。
* **`dsh` 版本被钉住**。`@deepseek-ai/dsh-headless` 的 `latest` dist-tag 落后于 CLI（对 0.2.x 的 CLI 是 `0.0.1-rc.1`），装上这一对会让 DSH 以 peerDependencies 不兼容为由拒绝该插件。钉住 CLI 版本保证镜像可复现；升级用 `--build-arg DSH_VERSION=<version>`。

容器化 DSH 的原生 resume 与本地一致：Native Session 落在挂载的 Native State 里，容器销毁后用 `--session-id` 恢复。

### 事件映射与 Usage

Local 与 Docker 共用同一个 Harness Parser（事件 / Session Ref / Usage / 错误），Execution Backend 只做传输：容器的 stdout/stderr 以原始行流交给对应 Harness Adapter，由同一套解析器处理。

* **Pi**（`pi --print --mode json`）：`session` 头、`agent_start/end`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end` → `run.progress` / `agent.message` / `agent.thinking` / `tool.started` / `tool.progress` / `tool.completed` / `runtime.error`。
* **OpenCode**（`opencode run --standalone --format json`，v2）：`step_start` / `text` / `reasoning` / `tool_use` / `step_finish` / `error`（每行携带 `sessionID`）→ 同一套标准事件。v2 的 `tool_use` part 用 `id` 承载 call id（v1 是 `callID`）、错误用 `error.type` 承载类型（v1 是 `error.name`），Adapter 两者都读。**已知上游缺陷**：v2 CLI 的 stdout 转发会丢掉最后一步的 `step_finish`（[opencode#53207](https://github.com/anomalyco/opencode/issues/53207)；下游报告 [multica#8892](https://github.com/multica-ai/multica/issues/8892)）。实测（2.0.21/2.0.26）稳定复现：服务端事件流与 session DB 里最后一步的 `tokens`/`cost` 完整存在（`session.step.ended`），丢的是 CLI——`session.wait()` 落定后转发循环进入 finalizing、只放行不带 usage 的 `session.execution.*`，最后一步的 `step_finish` 因此到不了 stdout。后果：v2 下 Run 的 Usage / Cost 少算最后一步（纯文本回答的 Run 显示为 0），中间工具步的 `step_finish` 照常输出。这是 CLI 的行为，不是 Adapter 的解析问题。
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

DSH 官方 headless bundle（`@deepseek-ai/dsh-headless`）提供完整的无头运行契约。认证与凭据是 harness-native，本地执行的可用性检测只看 `dsh --version`、headless profile 目录与 DSH 凭据文件的**存在性**，从不读取凭据内容；缺件时报错带补救命令（安装 CLI / `dsh plugin --profile headless add @deepseek-ai/dsh-headless` / 终端登录一次）。

`--session-id` 采纳 DSH 持久化的 Session，但 headless 的组成里没有 agent preset，DSH 的采纳校验因此**拒绝一切带 preset 的会话**——即 Desktop / Web surface 建的全部会话；同时也拒绝子代理/分叉会话，以及记录 cwd 与本次运行工作目录不一致的会话。这些校验全部由 DSH 自己在任务开始前强制执行，AgentFabric 原样透传其报错。所以 DSH 会话的完整图景是：Desktop/Web 会话——发现、读取、接管收历史，继续时走 Handoff 或其他 Runtime；只有 headless 自己建的会话能被 `--session-id` 原生续跑。

DSH 没有官方运行镜像，容器化执行需自备镜像（参考 `docker/dsh.Dockerfile`，原生状态挂载点 `/root/.dsh`）：容器内自带 CLI 与 headless profile，宿主侧的 CLI / profile / 凭据检测不参与容器化 Run 的判定。容器里的凭据要么是预置进 Native State 的 DSH 自己的 `.credentials.yaml`，要么通过 Runtime env / Secrets 注入（如 `DEEPSEEK_API_KEY`）；两者都没有时 DSH 在 Run 内报 `MISSING_CREDENTIAL` 并以退出码 1 结束。**turn 内的失败**（凭据缺失、provider 报错等）DSH 仍然会发 `final`，因此失败原因只出现在 `turn_end` 的 reason 里——适配器把它转成 `runtime.error`（保留 DSH 自己的 message 与 code），Run 不会只剩一个裸退出码。

DSH 没有 headless 侧的系统提示词 flag，Agent Profile 的系统指令以前置块拼进任务文本交付（与 Codex 同法）。

看板（Kanban）的 DSH 卡片走的是**另一条** DSH 路径：`dsh --profile acp` 以 ACP stdio 进程运行，由 AgentFabric 自己渲染对话（见「Kanban」一节），不产生 Run 事件、不经过这里的 headless 适配器；本节关于 headless profile、`--session-id` 采纳校验与容器化的描述都只适用于 Task / Run。

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
* **DSH Sessions（`kind: dsh`）**：读 DSH 的会话事件日志（`$DSH_HOME/sessions`，默认 `~/.dsh/sessions`，可用 `AGENTFABRIC_DSH_SESSIONS_DIR` 覆盖）下 `<encoded-cwd>/<session-id>/session[.vN].jsonl[.zstd]`。存储是全局一棵树：DSH 的所有 surface——Desktop / Web / headless / ACP（看板卡片）——写这同一个会话库，探测天然覆盖全部来源，无需按 profile 合并。会话头记录 `agentPreset`（可被会话中的 `agent-preset/selected` 事件改写），探测按 DSH 自己的算法重建出当前 preset 作为会话的 `source` 属性带出。标题取最后一个非空 `session/title` 事件——DSH 先落一条首条提问截断的占位标题（`source.kind: "fallback"`），生成的标题随后改写它；列表读到生成标题出现为止（512KB 解压预算兜底）。`.zstd` 日志是逐次追加的拼接 zstd 帧——探测器按帧头切分、逐帧解压（fzstd），列表只解到首个 turn 的标题与输入前缀，读取只整解目标会话那一份；`delegationDepth > 0` 的子代理会话不进列表（按 id 仍可读）。事件投影：`turn/start` 分轮，`user/message` 首条是轮输入，`assistant/message` 的 reasoning / text 块投影为推理与回复，`tool/call` 与 `tool/result` 按 `callId` 配对，`compaction/summary` 作为 reasoning 条目保留，流式 chunk 与 sandbox/approval/retry 状态不进对话。

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
* `shell` / `toolPermissions` 与 `autoApprove`（如 OpenCode `--auto`）传递给 Harness Adapter。OpenCode 侧 `toolPermissions` 只认 v2 规范工具名：`apply_patch` / `edit` / `execute` / `glob` / `grep` / `list` / `question` / `read` / `shell` / `skill` / `subagent` / `todowrite` / `todoread` / `webfetch` / `websearch`（v1 的 `bash` / `write` / `patch` / `task` 会收到 "unknown tools" 告警并被忽略）。

默认 Run 超时 `DEFAULT_RUN_TIMEOUT_MS` = 30 分钟。Policy 可在 Agent Profile、Task、Run 各层给出，Run 级覆盖 Task 级。

Validation 阶段同样受这份 policy 约束：validation 容器与 agent 容器用**同一个 resolver**（`policy.ts`）解析出同一份 `network`，`network.enabled=false` 时验证容器也是 `--network none`。validation 执行的是仓库里的不可信代码，网络权限绝不能比 agent 更大。

## 任务完成通知（Webhook）

一个 Coding Task 可能跑几十分钟，通知让「任务结束了」不必靠盯着页面。配置在 `config.notifications`（Settings → 通知，或 `PUT /api/config`）：

```jsonc
{
  "notifications": {
    "enabled": true,
    "url": "https://hooks.example.com/services/T000/B000/xxx",  // 必填；开启后缺 URL 是报错，不是静默跳过
    "headers": { "authorization": "Bearer xxx" },               // 可选，覆盖默认头
    "timeoutMs": 10000,                                          // 每次尝试的超时
    "maxAttempts": 3                                             // 含首次；1s/2s/… 指数退避，封顶 30s
  }
}
```

* **只在终态触发**：`task.completed` / `task.failed` / `task.cancelled` 各一次。中间阶段（如 `agent.completed`）不通知——此时 validation / finalization / publish 都还没跑完，提前说「完成」会在之后被推翻。
* **载荷来自记录本身**：`event`、`taskId`、`status`、`phase`、逐阶段 `stages`（原样拷贝，不重算）、`failure{stage,code,message}`、`finalCommitSha`、`workingBranch`、`durationMs`、`link`（`/tasks/<id>`，主机名由接收方决定）。instruction 默认截断到 300 字符并置 `instructionTruncated`。
* **通知永远不能改变 Task 的结果**：投递发生在终态写入**之后**，且 `deliverTaskNotification` 不抛异常——失败以 `DeliveryResult` 返回，写成 Run 上的 `notification-failed` 事件（带 `attempts` / `errorKind`）。Webhook 挂掉不会让任务变 failed。
* **重试策略**：网络错误、超时、429、5xx 重试；其余 4xx（token 错、路径错）立即放弃——重复不会让它变对。
* **URL 与 Header 都是密钥**：事件、日志、`GET /api/config` 里 URL 一律脱敏为 `scheme://host/***`（Slack/飞书 webhook 的路径就是 token），响应体里的回显也会被擦掉；`headers` 的值同样全部替换为 `***`（webhook 常用 `Authorization: Bearer …` 认证），只保留 header 名。`GET /api/config` 额外给出 `urlSet` 表明「是否已配置」而不暴露是哪一个。写回时（`af config` 是「读出 → 改一个字段 → 写回」；Settings 页只提交改动的那一个分区，见「Settings」一节）若收到恰好等于脱敏形式的 URL 或 header 值，按「未改动」处理并保留原值——占位符本身是合法 URL / 合法字符串，原样入库会静默把真 webhook 换成它；一个被打上 `***` 掩码、但存储里并不存在的 header 名按 `config-invalid` 明确报错（400），而不是把掩码存进去。
* **配置写入口做形状校验**：`notifications` 不是对象、`url` 不是字符串、`headers` 的值不是字符串都会以 `config-invalid`（HTTP 400）拒绝，存储中的原配置保持不变——一个被写坏的配置会让之后每次读取与投递都失败，必须在入口挡住。

## 自动重试（环境类失败）

一个跑了几十分钟的 Task 因为 docker 抽风、网络抖动、push 超时而失败，重试一次往往就好——不必等人盯页面。策略在 `config.autoRetry`（Settings → 自动重试，或 `PUT /api/config`）；这一项不需要重启，下一次重试判定就按新值走：

```jsonc
{
  "autoRetry": {
    "enabled": true,        // 默认 true；显式 false 关闭
    "maxAttempts": 2,       // 一次失败事件内的总尝试数（含首次），默认 2 = 自动重试 1 次
    "baseDelayMs": 30000,   // 退避基数：第 N 次等待 base × 2^(N-1)
    "maxDelayMs": 300000    // 退避上限
  }
}
```

* **只重试「环境坏了」，不重试「活干砸了」**。可自动重试的失败码只有这些：`source-network-failed`（clone/fetch/push 网络类；若失败发生在 push 且修订版已冻结，重推冻结 SHA 而不是重跑 agent）、`git-push-failed`（远端状态复核后仍失败的 push）、`validation-runtime-failed` / `validation-runtime-unavailable`（沙箱起不来、跑挂了）。`agent-failed` / `agent-timeout` / `validation-failed`（测试没过）/ `git-push-auth-failed` 等一律**不**自动重试——要么烧模型预算，要么掩盖真实信号，保持人工决策。
* **按阶段走既有操作，绝不发明通用 Retry Task**（v11 §31）：重试调用的就是 UI / API 上的 Retry Agent Run / Retry Validation / Retry Publish，三者语义不变。
* **预算属于一次失败事件**：`maxAttempts` 计的是同一失败事件内的总尝试数（含首次）；只有 Task 成功到达 `completed` 才清零。手动 retry 不重置计数，但三个手动入口永远可用。
* **全程可见**：`task.retry.scheduled`（含 `kind` / `attempt` / `delayMs` / `code`）、`task.retry.started`、`task.retry.skipped`（`reason` 为 `budget-exhausted` / `cancelled` / `superseded` / `guard`）都写在失败 run 的事件流上；Task 记录上的 `execution.autoRetry{attempts,code,nextAt,at}` 给出「已安排 / 已用次数」，Task 详情页在退避期间显示倒计时。
* **通知只报最终结局**：中间失败尝试不发 webhook（发了会被随后的重试推翻）；重试成功发 `task.completed`，预算耗尽发 `task.failed`——各恰好一次。
* **取消永远优先**：退避期间取消会中止重试（`task.retry.skipped`，reason `cancelled`）；被取消的 Task 无论失败码是什么都不会被重试唤醒（包括「取消落进 validation、沙箱把它报成 runtime 失败」这条路）。
* **不跨进程重启恢复**：进程死了，待发的重试一并作废（对齐 v11-hardening §18「重启后不得自动重新运行 Agent」）——恢复时清掉 `nextAt`、投递被抑制的终态通知，留一条诚实的失败记录，手动 retry 是下一步。
* 范围之外：agent 失败/超时、validation 断言失败不自动重试；没有 per-Task 重试配置（只有全局 `config.autoRetry`）；不做并发队列或调度器。

## Proxy

全局出网代理（Settings → 代理 / `config.proxy`）。默认关闭；打开后每个**新启动**的 Harness 进程收到标准代理环境变量，正在运行的进程与 AgentFabric 服务器本身不受影响。支持 `http` / `socks5`，容器化执行时 loopback 代理地址会改写到宿主机（`host.docker.internal`），且容器的 `NO_PROXY` 同时豁免 `host.docker.internal`——容器内对宿主机 loopback 服务（例如本地 Provider 网关）的请求直达宿主，不经代理绕行。「代理」分区提供连通性测试（`POST /api/proxy/test`）。

`Docker` 分区会显示本机 Docker 的真实状态：`GET /api/docker/status` 区分**未安装**（二进制不在 PATH）、**已安装但守护进程没运行**（CLI 在，daemon 连不上，并给出 socket 路径与原始报错）与**可用**（带服务端版本）。Docker 运行时需要本机 Docker 可用；没有可用的 Docker 时这个分区就是唯一能告诉你要修什么的地方；旁边的「重新检测」按钮按需重新探测。

**Provider base URL 与容器**：Provider 的 base URL 指向宿主机 loopback（`127.0.0.1` / `localhost` / `::1`，如本地模型网关）时，容器化 Run 生成的 harness 配置（pi `models.json` / opencode `opencode.json`）会自动改写为 `host.docker.internal`——容器内的 `127.0.0.1` 是容器自己，不改写则每次模型请求都连接失败。宿主执行（非容器化）保持原值不变。

## 数据与安全

* 数据保存在 `~/.fabric/db.json`（可用 `AGENTFABRIC_DATA_DIR` 覆盖到任意目录），原子写入。Workspace / WorkspaceLock 与既有集合一样存在同一个 store 里。
* Run 事件不进 db.json：事件负载按 run 分片，append-only 追加到 `~/.fabric/events/<runId>.jsonl`；db.json 只保留每 run 一行的索引（`eventShards`：文件、条数、字节数、`lastSeq` 高水位，`lastSeq` 同时用于重启后恢复全局 seq 计数器）。读取按需从分片文件载入。
* Workspace 记录只保存用户给的绝对路径，平台不复制也不删除该目录；记录本身随 `db.json` 一起持久化。
* Secrets 值仅在创建时返回一次，其余接口返回掩码；Secrets 不进入日志与事件；按 `secretIds` 注入 Runtime 环境变量。
* **Secret 值在 db.json 中静态加密**（AES-256-GCM）：密钥是 `<dataDir>/secret.key`（32 字节随机，hex 存储，`0600`，首次使用时生成），存储格式为 `enc:v1:<iv>:<authTag>:<ciphertext>`。没有兜底路径：不是 `enc:v1:` 格式的存量值按 `secret-legacy-format` 明确报错（升级前的明文 Secret 需重新录入一次），认证失败的按 `secret-decrypt-failed` 报错——绝不返回密文、空串或垃圾数据。`secret.key` 丢失或替换后旧值不可恢复。
* API Key 通过 `Provider.apiKeySecretId` 引用 Secret，Provider 记录中只有掩码；`GET /api/providers/:id/api-key` 需带 `X-AgentFabric-Reveal: 1` 请求头确认，返回的明文不进入任何日志。
* Git 凭据只在单次 Git 操作期间 materialize 到 `AGENTFABRIC_DATA_DIR/git-credentials/<op>-<random>`（操作结束立即删除）：HTTPS 走 `GIT_ASKPASS` + 子进程环境变量，SSH 走 `0600` 私钥文件 + `core.sshCommand`（`StrictHostKeyChecking=yes`）。远端 URL 始终不含凭据，`.git/config` 里也没有。
* Skill / MCP provisioning 落在 `AGENTFABRIC_DATA_DIR/provisioning/<runId>`，Run 结束即删除；生成的 MCP 配置是 `0600` 文件（可能含注入的 Secret 值），同样不进入日志与 API 响应。
* 通知 Webhook 的 URL 与 header 值本身即凭据（Slack Incoming Webhook 的路径就是 token），因此在事件、日志与 `GET /api/config` 中一律脱敏（URL → `scheme://host/***`，header 值 → `***`）；配置错误的通知在 Run 上以 `notification-failed` 事件可见，绝不静默丢弃。
* 存储层只保存生成时算出来的结果，读路径不重新解析、不重新投影、不做格式修补。

## CLI

```bash
# 数据目录默认 ~/.fabric，可用 AGENTFABRIC_DATA_DIR 覆盖；API 地址默认 http://localhost:7377
# （可用 AGENTFABRIC_API 或全局 --api <url> 覆盖，--json 输出原始 JSON）
# API Token 按 --token > AGENTFABRIC_TOKEN > <dataDir>/token 的顺序解析；找不到就报错，
# 绝不发出未认证的请求。token 值不会出现在任何输出里，只有文件路径。
# 注意 --token 的两种含义：写在子命令之前是 API token（全局选项），
# `af source-credentials add-https --token` 是 Git 凭据值（子命令选项）。
# 可重复选项（providers --header、models --param、agents --tool、run --tool）
# 每次出现追加一个值：`--tool read --tool edit` 得到两个工具；给 `providers update`
# 传 --header 同样生效（此前被静默丢弃）；`providers --enabled false` 可把已禁用的
# provider 重新启用或禁用，未传则 update 保持原值、add 默认启用。
# runtimes add --command 按 shell 引号切分：--command 'codex exec "fix the bug"'
# 是三个 argv，而不是五个。

# Provider / Model
af providers list | add | update | remove
af providers add my-openai --type openai-completions --base-url https://api.openai.com/v1 --api-key sk-xxx
af providers update my-openai --enabled false      # 禁用；--enabled true 重新启用
af models list | add | remove
af models add gpt-4o --provider <provider-id> --alias gpt-4o

# Runtime
af runtimes list | add | enable | disable | remove
af runtimes add "OpenCode" --kind opencode
af runtimes add "Pi Agent" --kind pi
# --isolated（或 --containerized）声明容器执行，必须同时给出 --image；
# --host 声明在宿主机执行。两者都可用于任何工作区任务。
af runtimes add "My Docker" --kind docker --isolated --image node:22-alpine --command "sh -c echo hi"

# Workspace / Agent Profile / Secrets
af workspaces add repo --path /path/to/code
af workspaces import legacy --path /existing/project    # 导入已有目录
af workspaces save <ws-id> --run <run-id>
af workspaces usage <ws-id>
af agents add "Senior Engineer" --runtime <rt> --model <model> --system-prompt "You are a senior engineer"
af secrets add my-key --value sk-xxx --scope env

# 工作区与任务
af workspaces list | show <id> | add <path> | update | remove | usage
af tasks detail <task-id>        # Workspace / Runtime / phase / retry
af tasks cancel <task-id>        # 终止 Runtime，Workspace 保留
af tasks retry-run <task-id> "继续修剩下的"   # 新 Run，复用同一 Workspace

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
             Execution Supervisor（任务生命周期）、领域错误模型、脱敏、
             Runtime 协议、Handoff 组装与渲染、Policy、Proxy、生命周期、
             Kanban 领域（看板工作区=Workspace / Card / 会话句柄与列规则，投影到 Task + Run）
  runtimes/  Runtime Adapters：mock / opencode / pi / codex / claude-code /
             dsh / docker，以及各 Harness 的本地会话探测与 Execution Backend
  server/    Express REST API + SSE + 静态 Web UI 托管 +
             Kanban 会话（node-pty 终端 / DSH ACP 聊天 / WebSocket / agent 启动契约）
  cli/       af 命令行（对接 REST API）
  web/       React + Vite Web UI
docker/      pi.Dockerfile / dsh.Dockerfile（容器化 Pi / DSH 的参考镜像）
docs/        harness-image-contract.md（容器化 Harness 镜像必须满足的契约）、
             interaction-audit-2026-10-25.md（交互逻辑审查报告：已审交互面、发现的问题与修法、验证现状）、
             kanban-dsh-acp.md / .html（Kanban 卡片驱动 DSH 的 ACP 实现原理，HTML 为可视化版）
scripts/     build-harness-images.sh（构建 Harness 镜像）、e2e-v11*.sh（端到端验证脚本）、
             fix-node-pty.js（修复 node-pty 预建 spawn-helper 的可执行位）
specs/       各阶段设计文档（历史归档，实现以代码为准）
```

## 已知边界

* 成本为内置价格表的估算值；harness-native Runtime 只采用 CLI 自报成本，绝不按 API 定价估算套餐 Run 成本。
* 持久化使用 JSON 文件，面向单机部署。
* Codex / Claude Code 仅支持本地执行，容器化被明确拒绝。
* ZCode 只有本地会话探测（读 `~/.zcode/cli/db/db.sqlite`），没有运行适配器——接管后继续执行会明确报错，跨 Harness 用 Handoff。
* DSH 没有官方容器镜像，容器化执行需自备镜像（参考 `docker/dsh.Dockerfile`）；Pi 同理（`docker/pi.Dockerfile`）。两者都不会自动构建镜像，也不会回退到普通 node 镜像——未配置 `runtime.image` 时拒绝启动。
* Network `allowedHosts` / `blockedHosts` 与 Filesystem `allowedPaths` / `deniedPaths` 未做细粒度强制（仅支持整体开关与只读挂载：`enabled=false` → `--network none`，`readOnly` → 只读挂载）。agent 容器与 validation 容器都遵守同一个整体开关。
* Agent Profiles 的 Web UI 入口未开放（API 与 CLI 可用）。
* Workspace 的 Snapshot / Fork / Diff 等高级能力未提供（Managed Workspace 的 Lock 已提供；Task 的最终 diff 以 artifact 形式提供）。
* **Secret 加密不做数据迁移**：升级前写入的明文 Secret 在读取时按 `secret-legacy-format` 明确报错，需要重新录入一次（值本身无法从旧记录恢复）。`secret.key` 必须随数据目录一起备份，丢失后已加密的值不可恢复。
* 通知只在**终态**触发一次，没有「开始 / 进度 / 卡住」类事件，也没有按事件类型分别配置订阅。
* **Kanban（v13）本期边界**：
  * Agent 作为宿主机子进程（PTY 或 ACP stdio）直接运行（Direct）或在本机 git worktree 中运行，不经过 Docker 隔离运行时（Direct 在宿主执行；Worktree 用本机 git worktree）。
  * Worktree 只支持工作区根自身是 Git 仓库；worktree 不自动删除、不自动 commit；multi-git / google-repo / 普通目录只能用 Direct。
  * 同一个看板工作区允许多个 Direct 会话并行，没有单写者锁；并发改动由 agent 自行处理。
  * 第一期没有 diff / review / commit / PR、依赖链与 auto-review；Review 列只表示「agent 完成一轮」，不是代码审查。
  * 第一期只做「创建」：不能在看板里编辑已有卡片的 prompt / 标题 / agent / 执行模式（改需求请在详情里 restart 或新建卡片），也不支持粘贴 / 拖拽图片。
  * 没有单独的「Start in plan mode」开关（用 agent 的 **Plan** 权限模式表达同一意图），也没有 forge 的 auto-review（commit / PR）选项——Review 列由 hooks / ACP turn 自动推进且不产生提交。Worktree 卡片在新目录里首次启动时，Claude Code 可能弹一次工作区信任确认，属于 CLI 自身行为。
  * DSH 没有官方交互 TUI；看板改用 ACP（`dsh --profile acp`）在卡片详情里渲染聊天，但 ACP app 是自动化面：没有 DSH 的 plan / todo / 终端卡片呈现，没有 `session/load`（本期不做 resume），也没有 DSH 的模型选择器（ACP 的 `configOptions` 未接到卡片的 model）。一个卡片同时只跑一个 ACP 进程；聊天记录只在内存，重启后旧卡片的聊天打不开，只能 restart 起新会话。本次改动前启动的卡片没有 `transport` 字段，按纯输出终端展示（不迁移）。DSH 需要 0.2.1+（自带 acp profile）；首次 `dsh --profile acp` 会从模板生成 profile，探测失败以 `kanban-agent-profile-missing` 报错。Claude Code / Pi / OpenCode 是否可用取决于本机 PATH，缺失时启动报 `kanban-agent-not-installed`。Pi 没有 hooks，进 Review 需要 Mark for review。
  * 会话输出不落盘：终端字节与 ACP 聊天记录都只在内存，服务重启后不能回放上一次会话；WS 不自动重连。
## 测试

```bash
npm run typecheck                                # 全仓库类型检查
npm test                                         # 全仓库测试（node:test）
npm run test -w @agentfabric/core                # 只跑 core
npm run build                                    # 构建全部 workspace（含 Web 产物）
```

测试脚本按 glob 收集 `src/*.test.ts`（core / runtimes / server），新增测试文件不需要改配置。

core 测试覆盖 store / secret / mock run / cost / event bus / policy / git workspace，容器生命周期策略与 keep-alive 租约，同 Harness Native Resume 与跨 Harness Handoff，Handoff 上下文选择、预算账目与渲染语义，能力声明与随执行后端收窄。

core 测试覆盖 store / secret / mock run / cost / event bus / policy / git workspace，容器生命周期策略与 keep-alive 租约，同 Harness Native Resume 与跨 Harness Handoff，Handoff 上下文选择、预算账目与渲染语义，能力声明与随执行后端收窄，以及看板领域（工作区 / 卡片 / 会话投影到 Task + Run）。

`packages/server/src/auth.test.ts` 覆盖本地 API 认证（Bearer / Cookie / 拒 query string / loopback CORS）、大小写变体的 API 路径同样要求认证、api-key reveal 确认、config 往返（脱敏 URL 与 header 掩码不被写回覆盖；掩码但无存储值 → 400 `config-invalid`；畸形 JSON → 400 `invalid-request`）与优雅停机。

v13 看板测试：`src/v13.kanban.test.ts` 覆盖 folder-first 目录、workspace 类型识别（none / git / multi-git / google-repo）、worktree 仅限 Git 项目根、多 direct 会话、卡片移动白名单、session → 列迁移、重启标记 interrupted 与删除级联、卡片标题派生、同目录去重、worktree base ref 存取，以及**看板统一**的关键断言：卡片首次启动产出 Task + Run（Run id 即会话句柄 id）、重跑同一卡片只新增 Run 而不新增 Task、续聊复用原 Run、三种终态的 `Task.execution` 投影、删除卡片是软删除、`board` 设置部分合并；`packages/server/src/kanban.terminal.test.ts` 用**真实 PTY** 验证 spawn / 输出 / 退出码 / resize / 进程组 stop / scrollback 上限；`packages/server/src/kanban.acp.test.ts` 用 fake ACP peer（stdio JSON-RPC，与 `dsh --profile acp` 同形）验证 initialize / session/new / 流式 update / 权限请求往返 / cancel / close / 进程退出（含真实 DSH 会在 stdout 打的非 JSON 噪声行）与 `session/resume` 能力广告 / 未广告时拒绝，并单独测 `AcpChatProjector` 按 `messageId` 聚合 chunk、按 `toolCallId` 合并 `tool_call_update`、从保存的转录恢复且不重用 id；`packages/server/src/kanban.transcript.test.ts` 覆盖转录原子读写、shutdown 同步写、损坏 / 旧版本文档按「没有历史」处理与按 session 删除；`packages/server/src/kanban.acp.runtime.test.ts` 把 fake `dsh` 放进 PATH，端到端跑真实 KanbanSessionRuntime：握手期 attach 与提前 prompt 被拒（`kanban-agent-starting`）、权限卡片问答、turn → Review、进程保持、同会话追问、stop 后 replay 已保存转录（`live:false` / `canResume:true`）、服务端重启后记录 `interrupted` 且转录仍可查看、`resume` 帧重新 spawn 并走 `session/resume` 续跑、二次重启仍能看到全部对话；`packages/server/src/kanban.agents.test.ts` 钉住 DSH 的 `--profile acp`、`transport: "acp"`、Ask / Auto-approve 权限模式与「prompt 不进 argv」；`packages/server/src/kanban.routes.test.ts` 用 fake CLI 端到端验证 REST + WebSocket（未认证升级被拒、restore 快照、输入、resize、stop）、真实 `git worktree` 隔离与 base ref 检出、目录浏览接口、非 Git 目录的询问/确认/去重、`git init`、本地 URL clone，以及 Claude Stop hook → 自动 Review、输入 → 回 In Progress、hook token 拒绝；`packages/server/src/kanban.hooks.test.ts` 覆盖 Claude settings / OpenCode plugin 的生成与 ESM 语法。

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

容器化 Pi / DSH 的镜像用 `bash scripts/build-harness-images.sh` 构建（`docker/pi.Dockerfile` / `docker/dsh.Dockerfile`，契约见 `docs/harness-image-contract.md`）。离线测试用 fake harness 覆盖同一条路径（`packages/core/src/v3.test.ts` 的 dsh 用例：无镜像拒绝 → 真进容器 → 跨容器销毁 Native Resume），不需要 Docker 与真实凭据。
