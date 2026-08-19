import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";

import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { authenticateSocket, userRoom, type AuthenticatedSocket } from "./auth.socket.js";

/**
 * Socket.IO foundation (TRD.md §6).
 *
 * Every connection is authenticated at the handshake (TRD §20) before any
 * handler runs. Chat, typing indicators, presence, notifications, and read
 * receipts are later phases and belong in their own handler modules
 * registered through `registerSocketHandlers`.
 */

let io: SocketIOServer | null = null;

/**
 * Runs only for sockets that passed `authenticateSocket`, so
 * `socket.data.user` is guaranteed present.
 *
 * The room name is derived from the *verified* user id — never from anything
 * the client sent — which is what stops a socket subscribing to someone
 * else's events.
 */
function registerSocketHandlers(socket: Socket): void {
  const { user } = (socket as AuthenticatedSocket).data;

  void socket.join(userRoom(user.id));
  logger.debug({ socketId: socket.id, userId: user.id }, "Socket connected");

  socket.on("disconnect", (reason) => {
    logger.debug({ socketId: socket.id, userId: user.id, reason }, "Socket disconnected");
  });
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
    // Matches the HTTP body cap so a socket frame cannot bypass it.
    maxHttpBufferSize: 1e6,
    // Drop dead connections faster than the default 20s/25s.
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  // Registered before the connection handler so an unauthenticated socket is
  // rejected during the handshake and never reaches application code.
  io.use((socket, next) => {
    void authenticateSocket(socket, next);
  });

  io.on("connection", registerSocketHandlers);

  logger.info("Socket.IO server initialized");
  return io;
}

/**
 * Accessor for code outside the socket layer that needs to emit. Throws
 * rather than returning null so a wiring mistake surfaces immediately.
 */
export function getSocketServer(): SocketIOServer {
  if (!io) {
    throw new Error("Socket.IO server accessed before initialization");
  }
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (!io) return;
  // Kick connected clients first so they get a clean disconnect event and can
  // reconnect to another instance, rather than hanging until ping timeout.
  io.disconnectSockets(true);
  await io.close();
  io = null;
  logger.info("Socket.IO server closed");
}
