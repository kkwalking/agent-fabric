import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../../components";
import type {
  ExecutionMode,
  KanbanAgent,
  KanbanGitInfo,
  TaskDraft,
  TaskFormDefaults,
  WorkspaceType,
} from "./types";

/**
 * New-task form (v13 §七), shared by the inline Backlog card and the "New task"
 * dialog so both entry points offer exactly the same choices.
 *
 * Mirrors the fork's task creation: prompt first, optional title (auto-derived
 * when empty), then the execution options — agent, model, permission mode,
 * workspace mode and worktree base ref. Cmd/Ctrl+Enter creates, Shift+Cmd/Ctrl+
 * Enter creates and starts the agent. The dialog variant can split a numbered
 * list into several cards and can stay open for more ("Create more").
 */

export interface TaskCreateSubmissionOptions {
  start: boolean;
  keepOpen: boolean;
}

export function deriveCardTitle(prompt: string, maxChars = 80): string {
  const firstLine =
    prompt
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const stripped = firstLine.replace(/^<[^>]+>/u, "").replace(/<\/[^>]+>$/u, "");
  const normalized = stripped.replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/u)?.[1] ?? normalized;
  if (sentence.length <= maxChars) return sentence;
  return `${sentence.slice(0, maxChars).trimEnd()}…`;
}

/** Recognizes a numbered or bulleted list, so one prompt can become N cards. */
export function parseListItems(text: string): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const numbered = /^\s*\d+[.)]\s+(.+)$/u;
  const numberedItems = lines.map((line) => numbered.exec(line));
  if (numberedItems.every((match) => match !== null)) {
    return numberedItems.map((match) => match![1]!.trim());
  }
  const bullet = /^\s*[-*+•]\s+(.+)$/u;
  const bulletItems = lines.map((line) => bullet.exec(line));
  if (bulletItems.every((match) => match !== null)) {
    return bulletItems.map((match) => match![1]!.trim());
  }
  return [];
}

const MODIFIER = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl";

export function TaskCreateForm({
  workspaceType,
  agents,
  git,
  defaults,
  allowSplit = false,
  allowCreateMore = false,
  createMore: controlledCreateMore,
  onCreateMoreChange,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  workspaceType: WorkspaceType;
  agents: KanbanAgent[];
  git: KanbanGitInfo | null;
  defaults: TaskFormDefaults;
  /** The dialog can split a numbered prompt into several cards. */
  allowSplit?: boolean;
  /** The dialog can stay open after creating ("Create more"). */
  allowCreateMore?: boolean;
  /**
   * Controlled "Create more". The dialog owns this so that creating another
   * card does not silently uncheck it; the form owns it otherwise.
   */
  createMore?: boolean;
  onCreateMoreChange?: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (draft: TaskDraft, options: TaskCreateSubmissionOptions) => void;
  onCancel?: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState(defaults.agentId ?? "");
  const [model, setModel] = useState(defaults.model ?? "");
  /** ACP agents (DSH): reasoning effort, applied before the first turn. */
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [permissionModeId, setPermissionModeId] = useState(defaults.permissionModeId ?? "");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(defaults.executionMode ?? "direct");
  const [baseRef, setBaseRef] = useState(defaults.baseRef ?? "");
  const [localCreateMore, setLocalCreateMore] = useState(false);
  const [mode, setMode] = useState<"single" | "multi">("single");
  const [taskPrompts, setTaskPrompts] = useState<string[]>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;

  // Agents load asynchronously and can change availability between projects.
  useEffect(() => {
    if (agentId && agents.some((agent) => agent.id === agentId)) return;
    const preferred =
      agents.find((agent) => agent.id === defaults.agentId && agent.available) ??
      agents.find((agent) => agent.available);
    if (preferred) setAgentId(preferred.id);
  }, [agents, agentId, defaults.agentId]);

  // Worktree mode is only meaningful when the project root is a Git repository.
  useEffect(() => {
    if (workspaceType !== "git" && executionMode === "worktree") setExecutionMode("direct");
  }, [workspaceType, executionMode]);

  // Seed the base ref from the branch the project is on, and repair a stale one.
  useEffect(() => {
    if (!git) return;
    const valid = baseRef && (git.branches.includes(baseRef) || baseRef === git.currentBranch);
    if (!valid) setBaseRef(git.currentBranch ?? git.defaultBranch ?? git.branches[0] ?? "");
  }, [git, baseRef]);

  useEffect(() => {
    if (focusIndex === null) return;
    const target = inputRefs.current[focusIndex];
    setFocusIndex(null);
    requestAnimationFrame(() => target?.focus());
  });

  const detectedItems = useMemo(() => (allowSplit ? parseListItems(prompt) : []), [allowSplit, prompt]);
  const createMore = controlledCreateMore ?? localCreateMore;
  const setCreateMore = onCreateMoreChange ?? setLocalCreateMore;

  const validTaskCount = useMemo(
    () => (mode === "multi" ? taskPrompts.filter((item) => item.trim()).length : prompt.trim() ? 1 : 0),
    [mode, prompt, taskPrompts]
  );

  const missingBaseRef = executionMode === "worktree" && Boolean(git?.branches.length) && !baseRef;
  const agentReady = Boolean(selectedAgent?.available);
  const canSubmit = validTaskCount > 0 && agentReady && !missingBaseRef && !busy;

  const splitIntoTasks = () => {
    setTaskPrompts(detectedItems);
    setMode("multi");
    setFocusIndex(0);
  };

  const backToSingle = () => {
    const joined = taskPrompts
      .filter((item) => item.trim())
      .map((item, index) => `${index + 1}. ${item.trim()}`)
      .join("\n");
    setPrompt(joined);
    setMode("single");
    setTaskPrompts([]);
  };

  const updateTask = (index: number, value: string) =>
    setTaskPrompts((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });

  const removeTask = (index: number) => {
    if (taskPrompts.length <= 1) return;
    setTaskPrompts((current) => current.filter((_, position) => position !== index));
    setFocusIndex(Math.min(index, taskPrompts.length - 2));
  };

  const addTask = (afterIndex?: number) => {
    const insertAt = afterIndex === undefined ? taskPrompts.length : afterIndex + 1;
    setTaskPrompts((current) => {
      const next = [...current];
      next.splice(insertAt, 0, "");
      return next;
    });
    setFocusIndex(insertAt);
  };

  const submit = (start: boolean) => {
    if (!canSubmit) return;
    const prompts =
      mode === "multi"
        ? taskPrompts.map((item) => item.trim()).filter(Boolean)
        : [prompt.trim()].filter(Boolean);
    if (prompts.length === 0) return;
    onSubmit(
      {
        prompts,
        ...(mode === "single" && title.trim() ? { title: title.trim() } : {}),
        agentId,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(selectedAgent?.transport === "acp" && reasoningEffort
          ? { reasoningEffort }
          : {}),
        ...(permissionModeId ? { permissionModeId } : {}),
        executionMode,
        ...(executionMode === "worktree" && baseRef ? { baseRef } : {}),
      },
      { start, keepOpen: createMore }
    );
  };

  const handleMultiKeyDown = (index: number, event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit(event.shiftKey);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      addTask(index);
      return;
    }
    if (event.key === "Backspace" && taskPrompts[index] === "" && taskPrompts.length > 1) {
      event.preventDefault();
      removeTask(index);
    }
  };

  const titlePlaceholder = deriveCardTitle(prompt) || "Auto-generated from the prompt";
  // The catalog's "default" mode has no extra args, which is exactly what
  // "Agent default" selects; listing both would be two names for one choice.
  const permissionModes = (selectedAgent?.permissionModes ?? []).filter((mode) => mode.id !== "default");
  const startLabel = mode === "multi" ? `Start ${validTaskCount} tasks` : "Create & start";
  const createLabel = mode === "multi" ? `Create ${validTaskCount} tasks` : "Create";

  return (
    <div
      className="task-create"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submit(event.shiftKey);
        }
      }}
    >
      {mode === "single" ? (
        <>
          <textarea
            className="task-create-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the task…"
            aria-label="Task prompt"
            autoFocus
          />
          <div className="task-create-prompt-foot">
            <span className="board-hint">
              {MODIFIER}+↵ to create · ⇧{MODIFIER}+↵ to create &amp; start
            </span>
            {detectedItems.length >= 2 && (
              <button type="button" className="task-create-split" onClick={splitIntoTasks}>
                <Icon name="grid" size={11} /> Split into {detectedItems.length} tasks
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="task-create-multi">
          {taskPrompts.map((item, index) => (
            <div className="task-create-multi-row" key={index}>
              <span className="task-create-multi-index">{index + 1}.</span>
              <input
                type="text"
                value={item}
                ref={(element) => {
                  inputRefs.current[index] = element;
                }}
                onChange={(event) => updateTask(index, event.target.value)}
                onKeyDown={(event) => handleMultiKeyDown(index, event)}
                placeholder="Describe the task…"
                aria-label={`Task ${index + 1}`}
              />
              <button
                type="button"
                className="task-create-multi-remove"
                onClick={() => removeTask(index)}
                aria-label={`Remove task ${index + 1}`}
                disabled={taskPrompts.length <= 1}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="task-create-multi-actions">
            <button type="button" className="task-create-split" onClick={() => addTask()}>
              <Icon name="plus" size={11} /> Add task
            </button>
            <button type="button" className="task-create-split" onClick={backToSingle}>
              <Icon name="arrowLeft" size={11} /> Back to single prompt
            </button>
          </div>
        </div>
      )}

      <div className="task-create-options">
        {mode === "single" && (
          <div className="board-dialog-field">
            <label className="board-dialog-label" htmlFor="task-create-title">
              Title <span className="task-create-optional">(optional)</span>
            </label>
            <input
              id="task-create-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={titlePlaceholder}
              className="task-create-title"
            />
          </div>
        )}

        <div className="board-dialog-field">
          <span className="board-dialog-label">Agent</span>
          <div className="task-agent-row">
            {agents.map((agent) => (
              <button
                type="button"
                key={agent.id}
                className={`task-agent-chip ${agent.id === agentId ? "active" : ""} ${
                  agent.available ? "" : "missing"
                }`}
                aria-pressed={agent.id === agentId}
                disabled={!agent.available || busy}
                title={agent.available ? agent.label : `${agent.label} — ${agent.installHint}`}
                onClick={() => {
                  setAgentId(agent.id);
                  setPermissionModeId("");
                }}
              >
                {agent.label}
              </button>
            ))}
            {agents.length === 0 && <span className="board-hint">Loading agents…</span>}
          </div>
          {selectedAgent && !selectedAgent.available && (
            <div className="board-hint warn">
              {selectedAgent.label} is not installed — {selectedAgent.installHint}
            </div>
          )}
          {agents.length > 0 && !agents.some((agent) => agent.available) && (
            <div className="board-hint warn">No agent CLI is installed on this machine.</div>
          )}
        </div>

        <div className="task-create-grid">
          {(selectedAgent?.modelFlag || selectedAgent?.transport === "acp") && (
            <div className="board-dialog-field">
              <label className="board-dialog-label" htmlFor="task-create-model">
                Model <span className="task-create-optional">(optional)</span>
              </label>
              <input
                id="task-create-model"
                className="mono"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={
                  selectedAgent?.transport === "acp"
                    ? "agent default — e.g. deepseek-v4-pro or DeepSeek-V4-Pro"
                    : "agent default"
                }
                disabled={busy}
              />
            </div>
          )}
          {selectedAgent?.transport === "acp" && (
            <div className="board-dialog-field">
              <label className="board-dialog-label" htmlFor="task-create-effort">
                Reasoning effort <span className="task-create-optional">(optional)</span>
              </label>
              <select
                id="task-create-effort"
                value={reasoningEffort}
                onChange={(event) => setReasoningEffort(event.target.value)}
                disabled={busy}
              >
                <option value="">agent default</option>
                {["off", "low", "high", "max"].map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* One non-default mode is still a real choice (DSH Ask/Auto,
              OpenCode Auto): hiding the select made it unreachable. */}
          {permissionModes.length > 0 && (
            <div className="board-dialog-field">
              <label className="board-dialog-label" htmlFor="task-create-permission">
                Permission mode
              </label>
              <select
                id="task-create-permission"
                value={permissionModeId}
                onChange={(event) => setPermissionModeId(event.target.value)}
                disabled={busy}
              >
                <option value="">Agent default</option>
                {permissionModes.map((permissionMode) => (
                  <option key={permissionMode.id} value={permissionMode.id}>
                    {permissionMode.label}
                    {permissionMode.risky ? " (risky)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="board-dialog-field">
          <span className="board-dialog-label">Workspace</span>
          <div className="board-mode-row">
            <button
              type="button"
              className={`board-mode-option ${executionMode === "direct" ? "active" : ""}`}
              aria-pressed={executionMode === "direct"}
              disabled={busy}
              onClick={() => setExecutionMode("direct")}
            >
              Direct
            </button>
            <button
              type="button"
              className={`board-mode-option ${executionMode === "worktree" ? "active" : ""}`}
              aria-pressed={executionMode === "worktree"}
              disabled={busy || workspaceType !== "git"}
              title={
                workspaceType === "git"
                  ? "Run in a detached Git worktree; the project tree stays untouched"
                  : "Worktree mode needs a Git repository at the project root"
              }
              onClick={() => setExecutionMode("worktree")}
            >
              Worktree
            </button>
          </div>
          <div className="board-hint">
            {workspaceType === "git"
              ? executionMode === "direct"
                ? "Runs in the project folder. Changes are live as the agent makes them."
                : "Runs in a detached worktree checked out from the base ref; the project tree stays untouched."
              : "This project has no Git repository at its root, so cards run Direct only."}
          </div>
          {executionMode === "worktree" && git && (
            <div className="board-dialog-field task-create-base-ref">
              <label className="board-dialog-label" htmlFor="task-create-base-ref">
                Worktree base ref
              </label>
              <select
                id="task-create-base-ref"
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                disabled={busy}
              >
                {git.branches.length === 0 ? (
                  <option value="">Current HEAD</option>
                ) : (
                  git.branches.map((branch) => (
                    <option key={branch} value={branch}>
                      {branch}
                      {branch === git.currentBranch ? " (current)" : ""}
                      {branch !== git.currentBranch && branch === git.defaultBranch ? " (default)" : ""}
                    </option>
                  ))
                )}
              </select>
              {missingBaseRef && <div className="board-hint warn">Pick a base ref for the worktree.</div>}
            </div>
          )}
        </div>
      </div>

      {error && <div className="board-hint warn task-create-error">{error}</div>}

      <div className="task-create-actions">
        {onCancel && (
          <button type="button" className="small" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
        {allowCreateMore && (
          <label className="task-create-more">
            <input
              type="checkbox"
              checked={createMore}
              onChange={(event) => setCreateMore(event.target.checked)}
              disabled={busy}
            />
            Create more
          </label>
        )}
        <div className="task-create-buttons">
          <button type="button" className="small" onClick={() => submit(false)} disabled={!canSubmit}>
            {busy ? "Creating…" : createLabel}
            <span className="task-create-shortcut">{MODIFIER}+↵</span>
          </button>
          <button type="button" className="small primary" onClick={() => submit(true)} disabled={!canSubmit}>
            {busy ? "Starting…" : startLabel}
            <span className="task-create-shortcut">⇧{MODIFIER}+↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
