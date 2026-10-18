# Kanban 卡片驱动 DSH：ACP 实现原理

本文讲**一张 Kanban 卡片通过 ACP（Agent Client Protocol）驱动 DSH 时，AgentFabric 里发生了什么**：进程怎么起、协议怎么谈、界面数据从哪来、重启后凭什么还能接着聊。规格层面的约定见 `specs/v13.md`，本文讲实现。

读者对象：要改这块代码的人。读完后你应该能回答：一次 turn 的字节从哪来到哪去、卡片状态是谁写的、服务端重启时哪些东西活下来、模型选择在哪一层生效。

---

## 一、为什么是 ACP

DSH 自带的 surface 没有交互 TUI，headless 是一次性输出。两者都不能支撑「看着 agent 干活、随时插话、回答权限请求」这种 Kanban 卡片需要的体验。

ACP 是 DSH 提供的自动化 stdio 协议：newline-delimited JSON-RPC 2.0，能创建/接回会话、发送 prompt、流式收 update、询问权限、切换模型。AgentFabric 说话，DSH 干活，界面由 AgentFabric 自己渲染。

三个候选方案的取舍：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 嵌 DSH Web UI（iframe） | ✗ 放弃 | 同源限制、无法深链、依赖私有接口、每个会话一份 Web 进程 |
| DSH SDK JSON-RPC | ✗ 放弃 | 没有权限审批、cancel、close 语义 |
| PTY 跑 TUI | ✗ 放弃 | DSH 本身不提供 TUI，没有可嵌的字节流 |
| **ACP stdio（`dsh --profile acp`）** | ✓ 采用 | 会话、turn、权限、取消、模型选择全在协议内 |

代价要说清楚：ACP 是 automation-only 表面，**没有** DSH 的 plan / todo / 终端卡片视图，也没有 `session/load`（不回放历史）。历史由 AgentFabric 自己保存和显示。

---

## 二、组件与职责

```text
浏览器（AcpChat.tsx）
   │  WebSocket  /api/kanban/sessions/:id/agent   （JSON 文本帧）
   ▼
KanbanSessionRuntime（sessions.ts）       ← 进程与状态的所有者
   ├── AcpSession（acp.ts）               ← 只负责 JSON-RPC 线
   ├── AcpChatProjector（acpChat.ts）     ← session/update → 聊天条目
   └── KanbanTranscriptStore（transcript.ts） ← 转录落盘
   ▼
dsh --profile acp（独立进程组）
```

分层规则：

- `acp.ts` 只懂协议，不碰卡片、不碰数据库。
- `probing`/`rendering` 之外的一切状态（卡片列、会话状态）由 `KanbanSessionRuntime` 写 `KanbanService`。
- Web 端只做 upsert 和展示，从不自己推断状态。

---

## 三、一次 turn 的完整链路

### 3.1 启动

```text
POST /api/kanban/cards/:id/start
  → assertKanbanAgentAvailable(card)        检查 dsh 与 acp profile
  → kanban.createSession(...)               先建记录（失败也有地方记）
  → [worktree 模式] git worktree add
  → startAcp(...)
       spawn dsh --profile acp（detached，独立进程组）
       initialize               → 拿到 agentCapabilities（含 resume 能力）
       session/new {cwd, mcpServers: []}
                                 → sessionId + configOptions（模型目录）
       applyCardConfig(...)      按卡片的 model / effort 调 set_config_option
       syncAcpConfig(...)        modelRoute / reasoningEffort 写进记录
       记 status=running、nativeSessionId
       runAcpPrompt(card.prompt)
```

**记录先于进程**。`createSession` 在 spawn 之前，所以握手失败、spawn 失败、模型不存在，都有地方记录失败原因，卡片不会变成「没有会话的孤儿」。

### 3.2 一个 turn

```text
客户端帧 {type:"prompt", text}
  → runAcpPrompt
       projector.addUser(text)         先上屏（ACP 不回显用户消息）
       updateSession(status=running)、卡片列 → in_progress
       session/prompt {sessionId, prompt:[text]}
              ← session/update ×N（流式）
              ← session/request_permission（可能）
              ← {stopReason}
       end_turn / cancelled → status=awaiting_review、卡片列 → review
       其他 stopReason      → status=failed
       flush 转录 → 广播状态
```

进程**不随 turn 结束而退出**：这是「turn 结束还能继续追问」的前提，也是「进程存在 ≠ 正在干活」这个区别的来源。

### 3.3 update 的投影

`AcpChatProjector` 把协议事件变成 UI 条目，纯函数、可单测：

| `sessionUpdate` | 聊天条目 | 说明 |
| --- | --- | --- |
| `agent_message_chunk` | `agent` | 按 `messageId` 聚合同一段回复 |
| `agent_thought_chunk` | `reasoning` | 默认折叠的 Thinking |
| `tool_call` / `tool_call_update` | `tool` | 按 `toolCallId` upsert，pending/in_progress → running |
| `config_option_update` | 不进聊天 | 同步到 composer 的模型/强度下拉 |
| `usage_update` | 不进聊天 | 只更新顶栏 token 用量 |
| `user_message_chunk` | 忽略 | 用户消息由 AgentFabric 自己加，避免重复 |

工具输出优先取 `content`，缺失时回落 `rawOutput`；工具失败时 `status=error` 并把输出作为错误展示。

---

## 四、权限：谁来回答

`session/request_permission` 是 server → client 请求，`AcpSession` 把它变成事件，`onAcpPermission` 决定：

- 卡片权限模式 `auto`：直接选 ACP 给出的 `allow_always` 或 `allow_once`，不打断对话。
- 否则：请求广播到聊天，会话标 `needs_attention`，**卡片留在 In Progress**（等待人工不是「完成」）。

答案通过 `respondPermission(requestId, optionId|null)` 回写；`null` 是 ACP 的 cancelled outcome，turn 会以 `stopReason: "cancelled"` 结束。同一个请求被任一标签页回答后广播 `agent_permission_answered`，其他副本禁用按钮。

---

## 五、模型与推理强度

模型不走 argv，走 ACP 的 config option。

```text
session/new 或 session/resume
  → configOptions: [
      { id:"model", type:"select", currentValue:'["deepseek-official","deepseek-v4-flash"]',
        options:[{group:"deepseek-official", options:[...]}, ...] },
      { id:"reasoning_effort", type:"select", currentValue:"high", options:[off,low,high,max] }
    ]
```

规则：

1. **卡片是偏好，agent 是权威**。卡片的 `model` 在第一个 turn 前应用：按「完整 value → model id → 显示名」大小写不敏感匹配。匹配不到就 `kanban-agent-model-unavailable` 失败，**绝不静默回落到默认模型**。
2. **落进记录的是实际值**。应用结果投影成 `KanbanSession.modelRoute {value, provider?, model?, label?}` 与 `reasoningEffort`，卡片详情显示的就是它。
3. **聊天里可随时切换**。`set_config {configId, value}` → `session/set_config_option` → 广播完整新目录（`agent_composer`），下一个 turn 生效，不会打断进行中的 turn。
4. **agent 自己也能改**。DSH 发 `config_option_update` 时同样同步，所以预设切换、路由回落也会反映到 UI。

values 对协议不透明：AgentFabric 只做展示投影（DSH 的 `["provider","model"]` 形状），回写时原样发回。

---

## 六、重启、暂停与续跑

这是这块代码最容易误解的地方，分三层看。

### 6.1 什么活下来

| 东西 | 服务端重启后 |
| --- | --- |
| 子进程（`dsh --profile acp`） | ✗ 死掉（shutdown 杀进程组） |
| 会话记录（`kanbanSessions`） | ✓ 在 db.json，非终态被标 `interrupted` |
| `nativeSessionId` | ✓ 在记录里，DSH 那边会话仍在磁盘 |
| 聊天转录 | ✓ `dataDir/kanban-chats/<sessionId>.json` |

### 6.2 转录怎么落盘

`AcpChatProjector` 的条目就是「生成时算出来的结果」，直接写 JSON 文档，不进 db.json（否则一条流式消息会把整个库重写）。

写时机：

| 时机 | 方式 |
| --- | --- |
| 流式 chunk | 750ms 防抖 |
| turn 结束 / 权限请求 / 进程退出 / stop | 立即 flush |
| 服务端关闭 | 同步写（进程紧接着 exit） |

读取时只认自己的版本号；损坏或版本不符当作**没有历史**，不做读取时修补（AGENTS.md）。

### 6.3 attach 与续跑

```text
WS attach（会话没有进程）
  → loadAcpState：读转录 + 记录，建一个「只有转录」的状态
  → snapshot { items, live:false, canResume:true, hasTranscript, configOptions… }
  → 客户端显示 paused + 完整历史

用户直接打字（或点 Resume now）
  → prompt → ensureAgent
       ├─ 进程还活着 → 直接用
       ├─ 有 nativeSessionId → session/resume {sessionId, cwd}
       │      DSH 恢复自己的模型上下文；不回放旧 update
       │      成功后记录回到 awaiting_review，可继续发 turn
       └─ 没有记录 → session/new 起新会话
  → 接好后把这条消息作为正常 turn 发出
```

`ensureAgent` 用 `agentAttaches` Map 把并发 prompt 合并成一次 attach，所以连点两下发送不会起两个进程，也不会收到假的 "still starting"。

几条边界：

- resume 是**可被输入触发**的动作，但不会在重启时自动为每张卡片起进程。
- 没有可续跑的会话（极老的卡片）时，发送起新会话并在聊天里说明。
- resume 失败（会话被删、cwd 变了、被别的进程占用）明确报 `kanban-session-resume-failed`，不静默换成新会话。
- 升级前创建、从未写过转录的会话打开后没有历史可显示，但仍可 resume。

---

## 七、状态机

服务端是唯一权威，前端只展示与乐观更新。

```text
starting ──session/new 返回──→ running
running  ──end_turn/cancelled──→ awaiting_review   （进程不退，卡片进 Review）
running  ──request_permission──→ needs_attention   （卡片留在 In Progress）
running  ──stopReason 其他────→ failed
running  ──用户 stop──────────→ stopped
running  ──服务端重启─────────→ interrupted        （下次启动统一写）
awaiting_review / needs_attention ──新 prompt──→ running（卡片回 In Progress）
interrupted / stopped / failed ──resume──→ awaiting_review
```

「进程活着」和「正在干活」是两个独立事实：前者看 `AcpSession.running`，后者看 `state.running`。UI 的 live / working / idle / paused 就是从这两个事实加会话状态推出来的。

---

## 八、WebSocket 协议

端点 `/api/kanban/sessions/:id/agent`，鉴权与终端 socket 相同（`af_token` cookie 或 Bearer + loopback 同源）。

| 方向 | 帧 | 作用 |
| --- | --- | --- |
| server → client | `agent_snapshot` | attach 时的全量：条目、状态、live/canResume/resuming、configOptions、usage |
| server → client | `agent_item` | 按 `id` upsert 一条聊天条目 |
| server → client | `agent_status` | 状态 / running / live / canResume |
| server → client | `agent_composer` | 模型与强度的选项、当前值、token 用量 |
| server → client | `agent_permission(_answered)` | 权限请求与回答同步 |
| server → client | `agent_error` | 带 code 的失败 |
| client → server | `prompt` `cancel` `resume` `set_config` `permission` `stop` | 用户动作 |

不做自动重连。socket 断开只代表 detach，重新打开卡片会重新 attach 并收到新的 snapshot。

---

## 九、错误码

| code | 含义 |
| --- | --- |
| `kanban-agent-not-installed` / `kanban-agent-profile-missing` | dsh 或 acp profile 不可用 |
| `kanban-agent-model-unavailable` | 卡片要求的模型 agent 不提供 |
| `kanban-agent-effort-unavailable` | 卡片要求的推理强度不提供 |
| `kanban-agent-option-unknown` / `kanban-agent-option-failed` | 聊天里切换配置失败 |
| `kanban-agent-start-failed` | spawn 或握手失败 |
| `kanban-session-resume-failed` | 续跑失败（记录不改成新会话） |
| `kanban-session-unresumable` | 没有可续跑的会话 / 卡片状态不允许 |
| `kanban-agent-busy` | 上一轮还在跑 |
| `kanban-session-not-live` | 会话已停止 / 删除，或该状态没有进程可操作（例如对它切模型） |

---

## 十、测试策略

| 文件 | 覆盖 |
| --- | --- |
| `kanban.acp.test.ts` | 协议驱动：握手、新建、流式、权限往返、cancel、close、resume 能力、config option |
| `kanban.acp.runtime.test.ts` | fake `dsh` 进 PATH，跑真实 runtime：turn → Review、追问、stop 后 replay、重启后 resume、卡片模型/强度应用、聊天内切换、模型不存在时失败 |
| `kanban.transcript.test.ts` | 转录原子读写、shutdown 同步写、损坏视为无历史、按 session 删除 |
| `kanban.routes.test.ts` | REST + WebSocket 鉴权与传输守卫 |

联调提示：fake `dsh` 是真实 runtime 的替身，它的 `session/new` 也返回 `configOptions`，否则卡片模型永远无处应用——改 fake 时别省掉这部分。

---

## 十一、已知限制

- ACP 是 automation-only：没有 plan / todo / 终端卡片，没有 `session/load`，历史只能由 AgentFabric 自己显示。
- 每张活跃卡片一个 `dsh` 进程；进程随服务端优雅退出而死。服务端被 SIGKILL 时若残留子进程，resume 会报「会话已被占用」。
- 转录不设上限，长会话文件会变大；目前没有裁剪。
- 卡片的 `model` 是偏好，不是硬约束：agent 若在运行中自行切换路由，记录会跟随实际值。
