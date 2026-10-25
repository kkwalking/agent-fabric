/**
 * UI language.
 *
 * Two languages, Chinese and English, and one of them is always chosen: the
 * Chinese dictionary is the source of truth for the key set (`Messages` is its
 * type), the English one is checked complete against it by the compiler. A
 * missing translation is a build error, not a fallback to the other language.
 *
 * The choice is stored in the browser (`localStorage`), which is the only place
 * it is needed: it is this browser's preference, and switching it must not touch
 * the server's configuration file — the language of the UI is not part of how
 * AgentFabric runs.
 */

export type Language = "zh" | "en";

export const LANGUAGES: ReadonlyArray<{ id: Language; label: string }> = [
  { id: "zh", label: "简体中文" },
  { id: "en", label: "English" },
];

const STORAGE_KEY = "agentfabric.language";

/** The Chinese dictionary: the key-set source of truth. */
const zh = {
  /* ---- settings shell ---- */
  "settings.title": "设置",
  "settings.close": "关闭",
  "settings.openFile": "打开配置文件",
  "settings.openFile.error": "无法打开配置文件",
  "settings.nav.general": "通用设置",
  "settings.nav.llm": "模型",
  "settings.nav.proxy": "代理",
  "settings.nav.notifications": "通知",
  "settings.nav.harness": "Harness CLI 路径",
  "settings.nav.docker": "Docker",
  "settings.nav.retry": "自动重试",
  "settings.nav.credentials": "代码源凭据",
  "credentials.description":
    "Git 凭据（HTTPS token 或 SSH 私钥）是全局设置，不是项目数据：项目只按 id 引用一个凭据。凭据值存为 Secret，只在单次 Git 操作期间临时落地，不会进入远端 URL、命令行参数、日志或 agent 的运行环境。",
  "settings.nav.about": "关于",
  "settings.save": "保存",
  "settings.saved": "已保存",
  "settings.unsavedTitle": "有未保存的修改",
  "settings.unsavedBody": "关闭后这些修改会丢失。要先保存吗？",
  "settings.keepEditing": "继续编辑",
  "settings.discardAndClose": "丢弃并关闭",
  "settings.saving": "保存中…",
  "settings.unsaved": "有未保存的改动",
  "settings.discard": "放弃改动",
  "settings.restartHint": "这些设置从下一个任务开始生效。",
  "settings.retryLive": "自动重试的取值在下次重试判定时生效，不需要重启。",

  /* ---- file card ---- */
  "settings.file.title": "配置文件",
  "settings.file.path": "路径",
  "settings.file.updated": "最后修改",
  "settings.file.applied": "运行中的配置来自该文件（{at}）。",
  "settings.file.pending": "文件已在磁盘上修改，但尚未应用。",
  "settings.file.pendingApplied": "当前运行 {at} 应用的配置。",
  "settings.file.broken": "该文件不是有效的配置：{error}。运行中的配置不受影响，修好后再应用。",
  "settings.file.unknownKeys": "无法识别的键：{keys}。",
  "settings.file.reload": "重新读取",
  "settings.file.apply": "应用并重启",
  "settings.file.applying": "正在重启…",
  "settings.file.appliedOk": "已应用",
  "settings.file.appliedNoRestart": "配置已写入；当前进程不会重启，请手动重启服务。",
  "settings.file.restarting": "服务正在重启，等待重新连接…",
  "settings.file.restarted": "服务已重启。",
  "settings.file.restartTimeout": "服务没有在预期时间内重新连上。请检查终端日志。",
  "settings.file.hint": "文件使用 JSON。顶部 `$schema` 指向本服务提供的 JSON Schema，编辑器可据此补全键名并显示字段说明。",
  "settings.file.notLocal": "当前页面不是通过本机回环地址打开的，因此不会在服务器上打开文件；文件路径见上方。",

  /* ---- general ---- */
  "general.about": "关于",
  "general.language": "语言",
  "general.language.hint": "只影响本浏览器的界面语言。",
  "general.version": "版本",
  "general.dataDir": "数据目录",
  "general.server": "服务地址",
  "general.loopback": "仅监听本机回环地址，浏览器通过 API token 认证。",
  "general.env": "环境变量",
  "general.env.hint": "启动时提供的环境变量优先于配置文件里的同名设置；被写入的那一项以实际生效值为准。",

  /* ---- llm ---- */
  "llm.description":
    "供应商与模型都写在同一份配置文件的 providers 段：在这里保存会直接改写它，「打开配置文件」看到的就是这里的内容；手工改完文件后「应用并重启」同样会重建这里的列表。",

  /* ---- proxy ---- */
  "proxy.enabled": "启用代理",
  "proxy.scheme": "协议",
  "proxy.host": "地址",
  "proxy.port": "端口",
  "proxy.required": "启用代理时需要填写地址和 1–65535 之间的端口",
  "proxy.test": "测试连接",
  "proxy.testing": "测试中…",
  "proxy.testNeedsInput": "请先填写有效的地址和端口",
  "proxy.testOk": "连接成功（HTTP {status} · {latency}ms）— 经 {proxyUrl} 可访问外网",
  "proxy.testFailed": "连接失败：{error}",
  "proxy.description":
    "为后续任务启动的 harness 进程注入标准代理环境变量（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY）。运行中的任务不受影响；关闭开关时不注入任何变量，harness 继承 server 自身的环境。",
  "proxy.hint":
    "容器化任务会自动把 127.0.0.1 / localhost 改写为 host.docker.internal；NO_PROXY 始终包含 localhost, 127.0.0.1, ::1，本地回环流量不走代理。测试连接从 server 所在机器发起（与本地 harness 同一网络环境）。",

  /* ---- notifications ---- */
  "notifications.enabled": "任务结束时发送通知",
  "notifications.url": "Webhook 地址",
  "notifications.url.masked": "已配置（{masked}）",
  "notifications.url.unset": "未配置",
  "notifications.url.placeholder": "https://hooks.example.com/…",
  "notifications.url.hint": "Webhook 地址本身就是凭据，读回时只显示掩码；留空表示不修改。",
  "notifications.clear": "清除地址",
  "notifications.headers": "附加请求头",
  "notifications.headers.hint": "每行一条，格式 `名称: 值`。值按凭据处理，读回时只显示掩码；保持掩码表示不修改。",
  "notifications.timeout": "超时（毫秒）",
  "notifications.description": "任务进入终止状态时向 Webhook 发送一条通知。改动从下一个任务开始生效。",
  "notifications.needUrl": "启用通知时必须填写 Webhook 地址",

  /* ---- harness ---- */
  "harness.description": "覆盖各 harness CLI 的可执行文件路径。留空表示使用 PATH 中的命令。",
  "harness.claudeProjects": "~/.claude/projects 转录目录覆盖（一般留空）",

  /* ---- docker ---- */
  "docker.socket": "Docker socket 路径（留空使用默认）",
  "docker.image": "默认容器镜像",
  "docker.description":
    "容器化运行时使用本机的 Docker。运行时自身没有指定镜像时，才使用这里的默认镜像；单个运行的镜像在运行时设置里配置。",

  /* ---- retry ---- */
  "retry.description":
    "只自动重试环境原因导致的失败（网络抖动、验证沙箱没起来、推送前远端状态已变）。代理自己判定失败、超时或测试不通过的任务不会自动重试。",
  "retry.enabled": "启用自动重试（默认开启）",
  "retry.maxAttempts": "一次失败过程内的总尝试次数（含第一次）",
  "retry.baseDelay": "退避基数（毫秒）",
  "retry.maxDelay": "退避上限（毫秒）",
  "retry.formula": "第 N 次重试前等待 基数 × 2^(N-1)，不超过上限。",

  /* ---- sidebar ---- */
  "nav.tasks": "任务",
  "nav.kanban": "看板",
  "nav.llm": "模型",
  "nav.projects": "项目",
  "nav.runtimes": "运行时",
  "nav.sessions": "原生会话",
  "nav.handoffs": "交接",
  "nav.runs": "运行",
  "nav.usage": "用量",
  "nav.settings": "设置",
  "nav.newTask": "新建任务",
  "nav.resources": "资源",
  "nav.system": "系统",
  "sidebar.workspaces": "工作区",
  "sidebar.search": "搜索任务",
  "sidebar.more": "更多",
  "sidebar.noWorkspace": "未归类（没有工作区）",
  "sidebar.noTasks": "还没有任务。",
  "sidebar.loadFailed": "无法加载任务列表。",
  "sidebar.expandRest": "展开其余 {n} 个会话",
  "sidebar.collapseRest": "收起",
  "sidebar.newSession": "新会话",
  "sidebar.rowActions": "会话操作",
  "sidebar.pin": "置顶",
  "sidebar.unpin": "取消置顶",
  "sidebar.pinned": "已置顶",
  "sidebar.rename": "重命名",
  "sidebar.renameTitle": "会话标题",
  "sidebar.copyId": "复制会话 ID",
  "sidebar.copyFailed": "无法访问剪贴板，请手动复制。",
  "sidebar.delete": "删除会话",
  "sidebar.cancel": "取消",
  "sidebar.save": "保存",
  "sidebar.dismiss": "点击关闭",
  "sidebar.filter": "筛选工作区",
  "sidebar.newInWorkspace": "新建任务",
  "sidebar.filterPinned": "只看已置顶",
  "sidebar.filterProjects": "只看项目工作区",
  "sidebar.noMatches": "没有匹配的会话。",
  "sidebar.expandGroup": "展开工作区",
  "sidebar.collapseGroup": "折叠工作区",
  "sidebar.groupActions": "工作区操作",
  "sidebar.renameWorkspace": "重命名工作区",
  "sidebar.deleteWorkspace": "删除工作区",
  "sidebar.renameWorkspaceTitle": "工作区名称",
  "sidebar.deleteWorkspaceConfirm": "删除工作区「{name}」？它下面的 {n} 个会话会变成「未归类」，不会被删除。",
  "nav.expand": "展开菜单",
  "nav.collapse": "收起菜单",
  "nav.search": "搜索",
  "nav.notifications": "通知",
  "nav.localServer": "本机服务",
  "nav.api": "api",
} as const;

export type MessageKey = keyof typeof zh;

const en: Record<MessageKey, string> = {
  "settings.title": "Settings",
  "settings.close": "Close",
  "settings.openFile": "Open configuration file",
  "settings.openFile.error": "Could not open the configuration file",
  "settings.nav.general": "General",
  "settings.nav.llm": "Models",
  "settings.nav.proxy": "Proxy",
  "settings.nav.notifications": "Notifications",
  "settings.nav.harness": "Harness CLI paths",
  "settings.nav.docker": "Docker",
  "settings.nav.retry": "Automatic retry",
  "settings.nav.credentials": "Source credentials",
  "credentials.description":
    "Git credentials (an HTTPS token or an SSH private key) are global settings, not project data: a Project only references one by id. The value is stored as a Secret and is materialized for the duration of a single Git operation — never into a remote URL, a command argument, a log line or the agent's runtime.",
  "settings.nav.about": "About",
  "settings.save": "Save",
  "settings.saved": "Saved",
  "settings.unsavedTitle": "Unsaved changes",
  "settings.unsavedBody": "Closing now will discard these edits. Save first?",
  "settings.keepEditing": "Keep editing",
  "settings.discardAndClose": "Discard and close",
  "settings.saving": "Saving…",
  "settings.unsaved": "Unsaved changes",
  "settings.discard": "Discard changes",
  "settings.restartHint": "These settings apply from the next task.",
  "settings.retryLive": "Automatic retry values apply to the next retry decision — no restart needed.",

  "settings.file.title": "Configuration file",
  "settings.file.path": "Path",
  "settings.file.updated": "Last modified",
  "settings.file.applied": "The running configuration comes from this file (applied {at}).",
  "settings.file.pending": "The file was edited on disk but has not been applied.",
  "settings.file.pendingApplied": "The running configuration was applied {at}.",
  "settings.file.broken": "This file is not a valid configuration: {error}. The running configuration is unaffected; fix the file, then apply it.",
  "settings.file.unknownKeys": "Unrecognised keys: {keys}.",
  "settings.file.reload": "Reload",
  "settings.file.apply": "Apply and restart",
  "settings.file.applying": "Restarting…",
  "settings.file.appliedOk": "Applied",
  "settings.file.appliedNoRestart": "Configuration written. This process will not restart itself — restart the server manually.",
  "settings.file.restarting": "The server is restarting; waiting to reconnect…",
  "settings.file.restarted": "The server restarted.",
  "settings.file.restartTimeout": "The server did not come back in time. Check its terminal output.",
  "settings.file.hint": "The file is JSON. Its `$schema` points at the JSON Schema this server publishes, so an editor can complete key names and show what each field does.",
  "settings.file.notLocal": "This page was not opened over a loopback address, so the file will not be opened on the server; its path is above.",

  "general.about": "About",
  "general.language": "Language",
  "general.language.hint": "Changes this browser's interface language only.",
  "general.version": "Version",
  "general.dataDir": "Data directory",
  "general.server": "Server address",
  "general.loopback": "Listens on the loopback address only; the browser authenticates with the API token.",
  "general.env": "Environment variables",
  "general.env.hint": "A variable set at launch wins over the same setting in the file; whichever value is in effect is what gets written back.",

  "llm.description":
    "Providers and their models are declared in the `providers` section of the same configuration file: saving here rewrites it, so the configuration file shows exactly this list, and applying a hand-edited file rebuilds it.",

  "proxy.enabled": "Enable proxy",
  "proxy.scheme": "Protocol",
  "proxy.host": "Host",
  "proxy.port": "Port",
  "proxy.required": "An enabled proxy needs a host and a port between 1 and 65535",
  "proxy.test": "Test connection",
  "proxy.testing": "Testing…",
  "proxy.testNeedsInput": "Fill in a valid host and port first",
  "proxy.testOk": "Connected (HTTP {status} · {latency}ms) — the internet is reachable through {proxyUrl}",
  "proxy.testFailed": "Connection failed: {error}",
  "proxy.description":
    "Injects the standard proxy environment variables (HTTP_PROXY / HTTPS_PROXY / ALL_PROXY) into the harness processes started for the next tasks. Running tasks are unaffected; with the switch off nothing is injected and the harness inherits the server's own environment.",
  "proxy.hint":
    "Containerized tasks rewrite 127.0.0.1 / localhost to host.docker.internal; NO_PROXY always includes localhost, 127.0.0.1 and ::1, so loopback traffic never goes through the proxy. The connection test runs from the server's machine — the same network the local harness sees.",

  "notifications.enabled": "Send a notification when a task finishes",
  "notifications.url": "Webhook URL",
  "notifications.url.masked": "Configured ({masked})",
  "notifications.url.unset": "Not configured",
  "notifications.url.placeholder": "https://hooks.example.com/…",
  "notifications.url.hint": "A webhook URL is itself a credential, so it is shown masked; leave it masked to keep it.",
  "notifications.clear": "Clear URL",
  "notifications.headers": "Extra request headers",
  "notifications.headers.hint": "One per line, `name: value`. Values are credentials and read back masked; keep a mask to leave it unchanged.",
  "notifications.timeout": "Timeout (ms)",
  "notifications.description": "Posts one notification when a task reaches a terminal state. Changes apply from the next task.",
  "notifications.needUrl": "Notifications need a webhook URL",

  "harness.description": "Override the executable path of each harness CLI. Empty means the command is looked up on PATH.",
  "harness.claudeProjects": "~/.claude/projects transcript root override (usually empty)",

  "docker.socket": "Docker socket path (empty for the default)",
  "docker.image": "Default container image",
  "docker.description":
    "Containerized runtimes use the machine's own Docker. This default image is used only when a runtime has none of its own; a single run's image is set on the runtime.",

  "retry.description":
    "Only failures caused by the environment are retried automatically (a network blip, a validation sandbox that did not start, a remote that changed before a push). A task the agent failed, that timed out, or whose tests failed is never retried automatically.",
  "retry.enabled": "Enable automatic retry (on by default)",
  "retry.maxAttempts": "Total attempts in one failure episode, including the first",
  "retry.baseDelay": "Backoff base (ms)",
  "retry.maxDelay": "Backoff cap (ms)",
  "retry.formula": "The wait before retry N is base × 2^(N-1), capped at the maximum.",

  "nav.tasks": "Tasks",
  "nav.kanban": "Kanban",
  "nav.llm": "LLM",
  "nav.projects": "Projects",
  "nav.runtimes": "Runtimes",
  "nav.sessions": "Native sessions",
  "nav.handoffs": "Handoffs",
  "nav.runs": "Runs",
  "nav.usage": "Usage",
  "nav.settings": "Settings",
  "nav.newTask": "New task",
  "nav.resources": "Resources",
  "nav.system": "System",
  "sidebar.workspaces": "Workspaces",
  "sidebar.search": "Search tasks",
  "sidebar.more": "More",
  "sidebar.noWorkspace": "Unfiled (no workspace)",
  "sidebar.noTasks": "No tasks yet.",
  "sidebar.loadFailed": "Could not load the task list.",
  "sidebar.expandRest": "Show {n} more sessions",
  "sidebar.collapseRest": "Show less",
  "sidebar.newSession": "New session",
  "sidebar.rowActions": "Session actions",
  "sidebar.pin": "Pin",
  "sidebar.unpin": "Unpin",
  "sidebar.pinned": "Pinned",
  "sidebar.rename": "Rename",
  "sidebar.renameTitle": "Session title",
  "sidebar.copyId": "Copy session ID",
  "sidebar.copyFailed": "The clipboard is not available — copy it by hand.",
  "sidebar.delete": "Delete session",
  "sidebar.cancel": "Cancel",
  "sidebar.save": "Save",
  "sidebar.dismiss": "Click to dismiss",
  "sidebar.filter": "Filter workspaces",
  "sidebar.newInWorkspace": "New task",
  "sidebar.filterPinned": "Pinned only",
  "sidebar.filterProjects": "Project workspaces only",
  "sidebar.noMatches": "No sessions match the filter.",
  "sidebar.expandGroup": "Expand workspace",
  "sidebar.collapseGroup": "Collapse workspace",
  "sidebar.groupActions": "Workspace actions",
  "sidebar.renameWorkspace": "Rename workspace",
  "sidebar.deleteWorkspace": "Delete workspace",
  "sidebar.renameWorkspaceTitle": "Workspace name",
  "sidebar.deleteWorkspaceConfirm": "Delete the workspace “{name}”? Its {n} session(s) become “Unfiled”; the sessions themselves are not deleted.",
  "nav.expand": "Expand menu",
  "nav.collapse": "Collapse menu",
  "nav.search": "Search",
  "nav.notifications": "Notifications",
  "nav.localServer": "local server",
  "nav.api": "api",
};

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { zh, en };

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Replaces `{name}` placeholders. An unknown name is left visible, not blanked. */
export function formatMessage(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  );
}

export function translate(language: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  return formatMessage(DICTIONARIES[language][key], vars);
}

/** The language this browser last chose; Chinese when nothing was stored. */
export function readStoredLanguage(): Language {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

export function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* a preference that cannot be stored must not break the app */
  }
}

/** Applies the language to the document itself (the browser tab's label and screen readers). */
export function applyDocumentLanguage(language: Language): void {
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
}
