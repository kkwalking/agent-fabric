/**
 * WebSocket upgrades for board sessions (v13 §5.1).
 *
 * Two transports hang off the same auth rule:
 * - `/api/kanban/sessions/:id/terminal` — PTY bytes (binary) + control JSON.
 * - `/api/kanban/sessions/:id/agent` — ACP chat frames (JSON only).
 *
 * Express never sees an upgrade request, so this is the one place where the
 * auth rule is applied outside middleware. The token comes from the same
 * `af_token` cookie / bearer header — never a query string. Browsers send the
 * cookie automatically for same-origin websockets; a cross-origin page does
 * not get the cookie, and an explicit Origin check makes that intent visible.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { headersCarryToken } from "../auth.js";
import type { KanbanSessionRuntime } from "./sessions.js";

const TERMINAL_PATH = /^\/api\/kanban\/sessions\/([^/]+)\/terminal\/?$/;
const AGENT_PATH = /^\/api\/kanban\/sessions\/([^/]+)\/agent\/?$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  const reason = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
      message
  );
  socket.destroy();
}

export function createKanbanUpgradeHandler(options: {
  token: string;
  runtime: KanbanSessionRuntime;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  return (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const terminalMatch = TERMINAL_PATH.exec(url.pathname);
    const agentMatch = AGENT_PATH.exec(url.pathname);
    const match = terminalMatch ?? agentMatch;
    if (!match) {
      socket.destroy();
      return;
    }
    if (!headersCarryToken(req.headers, options.token)) {
      reject(socket, 401, "Missing or invalid API token");
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && !isLoopbackOrigin(origin)) {
      reject(socket, 403, "Cross-origin board connections are not allowed");
      return;
    }
    // A malformed percent-encoding must not throw here: this runs inside the
    // raw `upgrade` listener, where an exception would take the whole server
    // (and every live session with it) down.
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(match[1]!);
    } catch {
      reject(socket, 400, "Malformed session id");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (terminalMatch) options.runtime.attach(sessionId, ws);
      else options.runtime.attachAgent(sessionId, ws);
    });
  };
}
