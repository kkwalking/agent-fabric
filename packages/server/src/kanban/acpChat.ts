/**
 * Projects ACP `session/update` notifications into chat items the board UI
 * renders (v13). Kept pure and transport-free so chunk aggregation and tool
 * merging are unit-testable without a harness.
 *
 * ACP streams *chunks* of one message (`messageId` groups them) and *updates*
 * of one tool call (`toolCallId` groups them), so the projector keeps a small
 * index by item id and mutates the item in place. The server broadcasts the
 * whole touched item on every change; the client upserts by id.
 */
import type { AcpUpdate } from "./acp.js";

export type ChatItem =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "agent"; text: string; at: string }
  | { id: string; kind: "reasoning"; text: string; at: string }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind?: string;
      status: "running" | "done" | "error";
      input?: unknown;
      output?: string;
      error?: string;
      at: string;
    }
  | { id: string; kind: "error"; message: string; at: string };

/** A message-level chunk or tool field that may be missing on updates. */
function textOfContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: unknown; text?: unknown; name?: unknown; uri?: unknown; resource?: { text?: unknown } };
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link") {
    const name = typeof block.name === "string" && block.name ? block.name : "resource";
    const uri = typeof block.uri === "string" ? block.uri : "";
    return uri ? `[${name}](${uri})` : `[${name}]`;
  }
  if (block.type === "resource" && block.resource && typeof block.resource.text === "string") {
    return block.resource.text;
  }
  return "";
}

/** Tool results arrive as `content` blocks (text, diff, terminal). */
function textOfToolContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const pieces: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as {
      type?: unknown;
      content?: unknown;
      path?: unknown;
      oldText?: unknown;
      newText?: unknown;
      terminalId?: unknown;
    };
    if (value.type === "content") {
      const text = textOfContent(value.content);
      if (text) pieces.push(text);
    } else if (value.type === "diff") {
      const path = typeof value.path === "string" ? value.path : "(file)";
      const added = typeof value.newText === "string" ? value.newText.split("\n").length : 0;
      pieces.push(`[diff] ${path} (${added} line${added === 1 ? "" : "s"})`);
    } else if (value.type === "terminal") {
      pieces.push(`[terminal ${String(value.terminalId ?? "")}]`);
    }
  }
  return pieces.join("\n");
}

function rawOutputText(rawOutput: unknown): string {
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput === undefined || rawOutput === null) return "";
  try {
    return JSON.stringify(rawOutput, null, 2);
  } catch {
    return String(rawOutput);
  }
}

/** The tool-call status vocabulary the UI understands. */
function toolStatus(status: unknown): "running" | "done" | "error" {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  // `pending` (awaiting approval) and `in_progress` both mean unfinished.
  return "running";
}

/** Tool output: the content collection wins, rawOutput is the fallback. */
function toolOutputText(update: AcpUpdate): string {
  const contentText = update.content !== undefined ? textOfToolContent(update.content) : "";
  if (contentText) return contentText;
  if (update.rawOutput !== undefined) return rawOutputText(update.rawOutput);
  return "";
}

export class AcpChatProjector {
  private readonly items: ChatItem[] = [];
  private readonly byId = new Map<string, ChatItem>();
  private seq = 0;
  /** Current streaming message ids, so id-less chunks still group per turn. */
  private currentAgentId: string | undefined;
  private currentThoughtId: string | undefined;

  /**
   * `initialItems` restores a transcript persisted by an earlier server
   * process. Item order is kept, and the counter restarts above every numeric
   * id so a continued conversation cannot reuse one.
   */
  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    initialItems: readonly ChatItem[] = []
  ) {
    for (const item of initialItems) {
      this.items.push(item);
      this.byId.set(item.id, item);
      const match = /:(\d+)$/.exec(item.id);
      if (match) this.seq = Math.max(this.seq, Number(match[1]));
    }
  }

  get snapshot(): readonly ChatItem[] {
    return this.items;
  }

  addUser(text: string): ChatItem {
    this.seq += 1;
    this.currentAgentId = undefined;
    this.currentThoughtId = undefined;
    const item: ChatItem = { id: `user:${this.seq}`, kind: "user", text, at: this.now() };
    this.push(item);
    return item;
  }

  addError(message: string): ChatItem {
    this.seq += 1;
    const item: ChatItem = { id: `error:${this.seq}`, kind: "error", message, at: this.now() };
    this.push(item);
    return item;
  }

  /** Apply one notification; returns the touched item, or null if ignored. */
  applyUpdate(update: AcpUpdate): ChatItem | null {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.appendChunk("agent", update);
      case "agent_thought_chunk":
        return this.appendChunk("reasoning", update);
      case "tool_call":
        return this.upsertTool(update);
      case "tool_call_update":
        return this.upsertTool(update);
      default:
        // user_message_chunk would echo the prompt the board already added;
        // usage/plan/config updates have no chat row in this transport.
        return null;
    }
  }

  private appendChunk(kind: "agent" | "reasoning", update: AcpUpdate): ChatItem | null {
    const text = textOfContent(update.content);
    const messageId = typeof update.messageId === "string" && update.messageId ? update.messageId : undefined;
    const prefix = kind === "agent" ? "msg" : "thought";
    let id: string;
    if (kind === "agent") {
      if (messageId) this.currentAgentId = `${prefix}:${messageId}`;
      id = this.currentAgentId ?? `${prefix}:turn-${this.seq}`;
      if (!this.byId.has(id)) this.currentAgentId = id;
    } else {
      if (messageId) this.currentThoughtId = `${prefix}:${messageId}`;
      id = this.currentThoughtId ?? `${prefix}:turn-${this.seq}`;
      if (!this.byId.has(id)) this.currentThoughtId = id;
    }
    const existing = this.byId.get(id);
    if (existing && (existing.kind === "agent" || existing.kind === "reasoning")) {
      existing.text += text;
      return text ? existing : null;
    }
    if (!text) return null;
    this.seq += 1;
    const item: ChatItem = { id, kind, text, at: this.now() };
    this.push(item);
    return item;
  }

  private upsertTool(update: AcpUpdate): ChatItem | null {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId) return null;
    this.seq += 1;
    const existing = this.byId.get(`tool:${toolCallId}`);
    if (existing && existing.kind === "tool") {
      if (typeof update.title === "string" && update.title) existing.title = update.title;
      if (typeof update.kind === "string" && update.kind) existing.toolKind = update.kind;
      if (update.status !== undefined && update.status !== null) existing.status = toolStatus(update.status);
      if (update.rawInput !== undefined) existing.input = update.rawInput;
      const output = toolOutputText(update);
      if (output) existing.output = output;
      if (existing.status === "error" && !existing.error) existing.error = existing.output || "Tool failed";
      return existing;
    }
    const title = typeof update.title === "string" && update.title ? update.title : typeof update.name === "string" ? update.name : "tool";
    const contentText = toolOutputText(update);
    const item: ChatItem = {
      id: `tool:${toolCallId}`,
      kind: "tool",
      toolCallId,
      title,
      ...(typeof update.kind === "string" && update.kind ? { toolKind: update.kind } : {}),
      status: toolStatus(update.status),
      ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
      ...(contentText ? { output: contentText } : {}),
      at: this.now(),
    };
    if (item.status === "error" && contentText) item.error = contentText;
    this.push(item);
    return item;
  }

  private push(item: ChatItem): void {
    this.items.push(item);
    this.byId.set(item.id, item);
  }
}
