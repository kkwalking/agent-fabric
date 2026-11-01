# UI 设计系统：令牌层、组件验收标准、暗色主题状态

这份文档记录 Web UI 的**视觉契约**。它回答三个问题：

1. 界面上的颜色、字号、圆角、阴影从哪里来（令牌层）；
2. 一个新组件要满足什么条件才算「符合设计系统」（验收标准）；
3. 设计系统里那套暗色配色现在是什么状态（**试点，不铺开**）。

品牌层的来源是 `designs/agentfabric-design-system/project/tokens.json`（设计系统 artifact，含 token 定义与组件预览）。代码里的唯一事实来源是 `packages/web/src/style.css` 顶部的 `:root`。

---

## 一、令牌层

### 1.1 为什么要有这一层

改动之前，`style.css` 自己长出了一套私有配色：同一个「次要文字」有 `#716f66`、`#a5a296`、`#9a9790` 三个近似灰；字号有 10 种、圆角有 9 种；还有 5 个 `var(--name)` 指向**从没定义过**的令牌（`--surface`、`--accent-soft`、`--border-bright`、`--danger`、`--heat-cell`）。

`var()` 引用未定义令牌**不报错**——浏览器把整条声明丢掉，属性回落到默认值。元素看起来「有点不对」，但没有任何日志、任何断点能指出来。这是这个文件最容易积累的一类坏味道。

### 1.2 令牌清单

| 家族 | 令牌 | 说明 |
| --- | --- | --- |
| 表面 | `--surface` / `--surface-raised` / `--surface-sunken` | 页面、卡片、下沉区（表格头、代码块） |
| 表面（交互） | `--surface-hover` / `--surface-active` | 悬浮、按下/选中；由品牌色保持色相、只调亮度派生 |
| 描边 | `--line` / `--line-soft` / `--line-strong` | 常规描边、更淡的分隔、悬浮与聚焦时的强化 |
| 墨色 | `--ink` / `--ink-strong` / `--ink-strong-hover` / `--ink-muted` / `--ink-dim` | 主文字、深底填充、次要文字、最淡一级 |
| 强调 | `--accent` / `--accent-text` / `--on-accent` / `--accent-soft` | 品牌橙；`--accent-text` 是它的 AA 文字步进 |
| 信号 | `--signal-blue/cyan/green/red/yellow/purple` | 状态色，每色都承担文字 |
| 字体族 | `--font-sans` / `--font-serif` / `--font-mono` | |
| 字号 | `--fs-2xs` … `--fs-display`（9 级） | 10.5 / 11.5 / 12.5 / 13.5 / 14 / 15 / 16 / 19 / 21px |
| 圆角 | `--radius-sm` / `-md` / `-lg` / `-xl` / `-full` + 派生 `-xs` | 6 / 8 / 12 / 22 / 9999px + 4px |
| 阴影 | `--shadow-card` / `-pop` / `-overlay` / `-composer` | |
| 焦点 | `--focus-ring` / `--focus-ring-tight` | |
| 热力图 | `--heat-0` … `--heat-4` / `--heat-cell` | 单色相五级；`--heat-cell` 必须与 `Usage.tsx` 的 `CELL` 一致 |

### 1.3 对比度：不是估算，是实测

所有文字色都按 WCAG 2.1 AA 校准，**并且是按最深的那个表面算的**（`--surface-active` #e9e9e6），不是按白底算。只按白底校准过的颜色，在选中的行上会掉到 4.1:1 —— 看起来「差不多」，实际不合格。

| 令牌 | 值 | 白底 | 下沉 | 悬浮 | 按下/选中 |
| --- | --- | --- | --- | --- | --- |
| `--ink-muted` | #5f5d55 | 6.60 | 6.00 | 5.88 | 5.42 |
| `--ink-dim` | #6a685f | 5.59 | 5.08 | 4.98 | 4.59 |
| `--accent-text` | #a84300 | 6.06 | 5.51 | 5.40 | 4.98 |
| `--signal-red` | #bd1c26 | 6.25 | 5.69 | 5.58 | 5.14 |
| `--signal-green` | #177032 | 6.18 | 5.62 | 5.51 | 5.08 |
| `--signal-yellow` | #855800 | 6.19 | 5.63 | 5.52 | 5.09 |
| `--signal-purple` | #7443cf | 6.09 | 5.54 | 5.44 | 5.01 |
| `--signal-blue` | #1f57d4 | 6.23 | 5.66 | 5.56 | 5.12 |
| `--signal-cyan` | #0b5fc4 | 6.09 | 5.54 | 5.43 | 5.01 |

两个例外，都是有意的：

* **`--accent` #e2620e 不用于正文小字**（白底 3.19:1）。它用于填充、边框、图标和大字号；正文链接用 `--accent-text`。这条分工写在 `:root` 的注释里。
* **`--on-accent` 是「实心块上的标签色」**（白），八个原始 `#fff` 站点全都落在 `--ink-strong` 或 `--signal-red` 上，从未落在 `--accent` 上。所以它保留原名、按「深底/实心填充上的文字色」使用，不再新增 `--on-ink` / `--on-signal` 这类同义令牌。

徽章底色是按**自己那个令牌色**以 8–9% 透明度叠出来的（例如绿徽章 = `rgba(23,112,50,.09)`），所以「标签色 / 底色」的对比度是同一色相内部的对比，天然稳定在 5.1–5.5:1，换表面也不变。

### 1.4 护栏：`packages/web/scripts/check-style-tokens.mjs`

`npm test -w @agentfabric/web` 的第一步就是跑它。规则：

1. 每个 `var(--x)` 必须在 `:root` 里有定义；
2. 不许 `var(--x, fallback)`——内联兜底正是「令牌名错了却在一张表面上看起来还行」的成因；
3. 每条声明的括号必须配平（脚本化改写曾产出 `var(--accent-soft));`，整条声明被丢掉）；
4. `font-size` / `border-radius` 不许写字面量——新尺寸是加令牌，不是加字面量；
5. `:root` 之外不许出现颜色字面量。

第 3 条按**声明**配平而不是按全局计数：`repeat(7, var(--heat-cell))` 的第二个 `)` 属于外层函数，全局计数会误报。

护栏是能咬人的——故意把 `var(--ink-muted)` 打成 `var(--ink-mutd)`，它会以退出码 1 失败并指出行号。

---

## 二、组件验收标准

设计系统 artifact 里的 `Button` / `Badge` / `Card` / `Cover` 是**品牌表达**（封面、演示、宣传）；Web UI 里的同名东西是**产品控件**，两者共享令牌但不共享尺寸。下面这份清单是产品控件进入界面的门槛——不是一个新组件的建议，是把它合进去之前要能逐条回答的问题。

### 2.1 Button

| 项 | 标准 |
| --- | --- |
| 尺寸 | 默认 `6px 12px` / `--fs-sm`；`small` 变体 `3px 9px` / `--fs-xs`；两者都用 `--radius-sm` |
| 权重 | `500`。**不要**用 550/620/650 这类插值——只有 400/500/600/700 四个字重是平台稳定渲染的 |
| 变体 | 默认（表面 + 描边）、`primary`（`--ink-strong` 填充 + `--on-accent` 文字）、`danger`（红字，描边只在 hover 变红）、`danger-prominent`（静止态就是红，用于远离安全操作的破坏性动作） |
| 悬浮 | `background: --surface-sunken` + `border-color: --line-strong`；两者同时变，只变一个是「半个反馈」 |
| 禁用 | `opacity: .55` + `cursor: not-allowed`。**不用**把文字改成 `--ink-dim`——那会让「禁用」和「三级文字」在视觉上撞车 |
| 焦点 | 由全局 `:focus-visible` 组统一给 `2px solid var(--accent)` + `2px` offset。组件自己不写 outline |
| 图标 + 文字 | 用 `button.icon-text`（`inline-flex` + `5px` gap），glyph 在前。不要用空格对齐 |
| 只做动作的东西**不能**是 `<a>` | 会跳转的用 `AppLink`（真 `href` + 前端路由接管）；只做动作的必须是 `<button>` |

### 2.2 Badge

| 项 | 标准 |
| --- | --- |
| 形状 | `--radius-full` + 小号字；只有状态药丸用全圆角 |
| 颜色 | 文字用对应 `--signal-*`，底色是**同一令牌色** 8–9% 透明度，不是另写一个浅色 |
| 语义 | 颜色只表达状态，不表达「好看程度」。同一个状态在列表、详情、看板上必须是同一个颜色 |
| 对比度 | 标签/底色 ≥ 4.5:1（见 1.3；徽章是自洽的，不需要逐表面重算） |
| 取消态 | `cancelled` 是**终态**，不是失败：用中性色，不要用 `--signal-red` |

### 2.3 Card

| 项 | 标准 |
| --- | --- |
| 结构 | `--surface-raised` 底 + `1px solid var(--line)` + `--radius-lg` + `--shadow-card` |
| 悬浮 | 只改描边与阴影，不改底色。卡片底色的变化要和「选中」区分开，否则两张卡并列时看不出哪张是 hover |
| 嵌套 | 卡片里不再套卡片。分组用 `--line-soft` 分隔线或 `--surface-sunken` 区块 |
| 阴影 | 卡片级只用 `--shadow-card`；浮层（下拉、气泡、悬浮读数）用 `--shadow-overlay`；中间那级 `--shadow-pop` 只给贴在内容上方的弹出面板 |
| 可点整卡 | 整卡可点时它必须是可聚焦的（`tabIndex`）并且有 `:focus-visible` 样式——`outline: none` 之后必须补回一个可见指示 |

### 2.4 Field（输入框 / 文本域 / 下拉）

| 项 | 标准 |
| --- | --- |
| 静止 | `--surface-raised` 底 + `1px solid var(--line)` + `--radius-sm` + `--fs-sm` |
| 聚焦 | `border-color: --line-strong` + `box-shadow: --focus-ring`。**不要留 `outline: none` 而没有替代指示** |
| 复合输入（带图标的目录框等） | 焦点在内层 `<input>` 时，指示画在外层容器上（`:focus-within`），否则用户看到的焦点框只包住文字那一段 |
| 占位符 | `--ink-dim`。占位符不是标签的替代，字段必须有可见标签 |
| 禁用 | 与 Button 同一条：降透明度，不改色阶 |
| 校验失败 | 红字 + `role="alert"`（读屏会播报）。错误说明放在字段下方，不要只改边框颜色 |

### 2.5 Modal

| 项 | 标准 |
| --- | --- |
| 名称 | `aria-labelledby` 指向**看得见的**标题元素，不要另传 `aria-label`——两份文案会各自漂移 |
| 焦点 | 打开时焦点进入对话框；Tab / Shift+Tab 在首尾循环；Esc 关闭后焦点**回到打开它的控件** |
| 遮罩 | `--shadow-overlay`；`aria-modal="true"` 只是声明，键盘陷阱必须真的实现 |
| 自身焦点 | 对话框本体可能先拿到焦点（内部没有可聚焦控件时），所以 `.modal:focus-visible` 也要有可见指示 |
| 危险操作 | 写清后果（「移入回收站，可在设置 → 回收站恢复」），不要只问「确定吗」 |

### 2.6 键盘可达性总则

* 所有可交互元素都在 Tab 序里，并且有 `:focus-visible` 指示。全局组覆盖 `input/select/textarea/button/a/[tabindex]`，行内还有一组覆盖 `.task-item` / `.provider-summary` / `.board-card` / `.modal` / `.board-project`。
* 用 `outline: none` 抹掉默认焦点框**必须**在同一处补一个替代指示（`--focus-ring` 或 `--focus-ring-tight`）。现在文件里剩下的 `outline: none` 都逐个确认过有替代。
* 站内跳转用 `AppLink`（真 `href`），带修饰键的点击交给浏览器。

---

## 三、暗色主题：试点，不铺开

设计系统的 `tokens.json` 给每个颜色令牌都写了 `dark` 值，组件预览也支持深色。**但产品 UI 没有暗色主题，这次也没有加。**

理由：

1. **`html { color-scheme: light }` 是显式声明**，不是遗漏。Web UI 的对比度、阴影、热力图色阶全部按浅色表面校准过；直接反转会把每一处重新算一遍。
2. **暗色下真正难的不是配色，是层级**。浅色靠「白卡片浮在灰底上」表达层级；暗色要把同一套层级用更高的亮度差表达，并且要重新处理描边（深色下描边比阴影更有效）、阴影（深色阴影几乎不可见）和热力图（`--heat-0` 在深色里是「最暗」，在浅色里是「最亮」）。
3. **这次改动没有引入任何暗色专属代码**。没有 `prefers-color-scheme` 分支，没有 `data-theme` 属性，没有双写。

所以现状是：

| 场景 | 状态 |
| --- | --- |
| Web UI（浅色） | 完整令牌化，AA 实测通过 |
| 设计系统 artifact（含 dark token） | 试点；作为**未来**暗色主题的取值来源 |
| 产品 UI 暗色主题 | **不做**。没有排期，没有半成品分支 |

要做的时候的正确起点是：先把令牌层保持不变，只把 `:root` 换成一个 `[data-theme="dark"]` 覆盖块，然后在真实窗口里逐面重测对比度与层级——不是把浅色值调暗。上面 1.3 那张表就是验收用的那张表，暗色版本要重新填一遍。

---

## 四、当前的验证状态

* `npm test -w @agentfabric/web`：护栏 + 7 项测试全通过。
* 对比度：12 条路由在真实浏览器里逐个遍历 DOM（含半透明叠加计算），**0 失败**：`/`、`/settings/*`、`/kanban`、`/runs`、`/runs/:id`、`/usage`、`/handoffs/:id`、`/tasks/:id`、`/new`、`/runtimes`、`/trash`、`/sessions`。
* 打包 App 的 CDP 断言（`verify-ui.mjs`）：133 项通过，5 项失败，**全部是主分支 `b442af9` 带进来的，与令牌层无关**：
  * 4 项热力图悬浮读数：断言用 `dispatchEvent(new MouseEvent("mouseenter"))`，但 `mouseenter` **不冒泡**，而 React 18 是在根节点用 `mouseover` 委托合成 `onMouseEnter` 的——这条断言永远触发不了。用 `mouseover`（`bubbles: true`）实测读数正常显示（`预估费用 / Token / 请求数` 三行齐全），`aria-label` 也在。**功能是好的，断言写错了。**
  * 1 项 OpenCode model picker：依赖本机 CLI 的实时目录，属于环境差异。
