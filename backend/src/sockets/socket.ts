import type { Server as HttpServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { Server as SocketIOServer, type Socket } from "socket.io";

import { env } from "../config/env.js";
import { createRedisClient } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { authenticateSocket, userRoom, type AuthenticatedSocket } from "./auth.socket.js";
import { registerMessageHandlers } from "./message.socket.js";
import { registerNotificationHandlers } from "./notification.socket.js";
import { registerPresenceHandlers, stopPresenceTracking } from "./presence.socket.js";

/**
 * Socket.IO foundation (TRD.md §6).
 *
 * Every connection is authenticated at the handshake (TRD §20) before any
 * handler runs. Chat, typing indicators, presence, and read receipts arrived in
 * Phase 8 and live in their own handler modules, registered below; notification
 * delivery is Phase 9 and will join them there.
 */

let io: SocketIOServer | null = null;
/** The adapter's two dedicated connections, closed with the server. */
let adapterClients: [Redis, Redis] | null = null;

/**
 * Runs only for sockets that passed `authenticateSocket`, so
 * `socket.data.user` is guaranteed present.
 *
 * The room name is derived from the *verified* user id — never from anything
 * the client sent — which is what stops a socket subscribing to someone
 * else's events.
 *
 * The user-room join happens first and unconditionally, before any feature
 * module is wired: everything Phase 8 emits is addressed to user rooms, so a
 * socket that somehow skipped this line would connect successfully and then
 * silently receive nothing.
 */
function registerSocketHandlers(socket: Socket): void {
  const authenticated = socket as AuthenticatedSocket;
  const { user } = authenticated.data;

  void socket.join(userRoom(user.id));
  logger.debug({ socketId: socket.id, userId: user.id }, "Socket connected");

  // Phase 8. Both take the already-authenticated socket; neither reads
  // identity from a payload.
  registerMessageHandlers(authenticated);
  registerPresenceHandlers(authenticated);
  // Phase 9. Registers no inbound handlers — `notification:new` is emitted to
  // the user room joined above — but is wired here so all three feature
  // modules attach the same way.
  registerNotificationHandlers(authenticated);

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

  /*
    Rooms shared through Redis rather than held in this process's memory.

    Every emit in the app is addressed to a user room — `io.to(userRoom(id))`.
    With the default in-memory adapter, that reaches only sockets connected to
    *this* process. On a single long-running server that is every socket, so
    it never mattered. On Vercel it is not: connections spread across function
    instances, and a message sent over REST lands on whichever instance took
    that request — usually not the one holding the recipient's socket. The
    emit then reaches nobody, with no error anywhere.

    The adapter publishes each emit to Redis, and every instance delivers it
    to its own sockets in that room. It needs two dedicated connections: a
    client in subscriber mode cannot issue ordinary commands, which is why
    `createRedisClient()` exists.
  */
  //
  // Both connect eagerly and queue while connecting — the opposite of the
  // shared client's lazy, fail-fast settings. Those suit request-path
  // commands; here the adapter subscribes the moment it is constructed, and
  // with no offline queue that subscribe is rejected before any connection
  // exists. Not `duplicate()`, which would copy exactly those settings.
  const adapterOptions = { lazyConnect: false, enableOfflineQueue: true };
  const pubClient = createRedisClient(adapterOptions);
  const subClient = createRedisClient(adapterOptions);
  adapterClients = [pubClient, subClient];
  io.adapter(createAdapter(pubClient, subClient));

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

/**
 * Non-throwing accessor, for emitters that are genuinely optional (Phase 8).
 *
 * `getSocketServer` throws so a *wiring* mistake surfaces immediately, and
 * that is right for code which cannot work without a socket server. Real-time
 * delivery is not such a case: a message sent over REST must persist and
 * succeed whether or not anyone is listening — the offline-recipient rule
 * depends on it, and the REST integration suites run with no socket server at
 * all. Those call sites ask, and skip the emit when the answer is null.
 */
export function tryGetSocketServer(): SocketIOServer | null {
  return io;
}

export async function closeSocketServer(): Promise<void> {
  if (!io) return;
  // Before the sockets are cut: stops the presence heartbeat interval, which
  // would otherwise outlive the server and keep a test process alive.
  stopPresenceTracking();
  // Kick connected clients first so they get a clean disconnect event and can
  // reconnect to another instance, rather than hanging until ping timeout.
  io.disconnectSockets(true);
  await io.close();
  io = null;
  if (adapterClients) {
    await Promise.allSettled(adapterClients.map((client) => client.quit()));
    adapterClients = null;
  }
  logger.info("Socket.IO server closed");
}
