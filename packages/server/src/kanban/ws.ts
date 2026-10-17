/**
 * WebSocket upgrade for a card terminal (v13 §5.1).
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
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
    const match = TERMINAL_PATH.exec(url.pathname);
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
      reject(socket, 403, "Cross-origin terminal connections are not allowed");
      return;
    }
    const sessionId = decodeURIComponent(match[1]!);
    wss.handleUpgrade(req, socket, head, (ws) => {
      options.runtime.attach(sessionId, ws);
    });
  };
}
