import { createServer } from "node:http";

import { createApp } from "./app.js";
import { connectRedis } from "./config/redis.js";
import { connectDatabase } from "./database/prisma.js";
import { createSocketServer } from "./sockets/socket.js";

/**
 * Vercel Function entrypoint. `server.ts` remains the entrypoint everywhere
 * else — local dev, Docker, any long-running host.
 *
 * The difference is who owns the port. `server.ts` calls `listen()`; on Vercel
 * the platform accepts connections and hands them to the exported server,
 * including WebSocket upgrades, so this module exports the `http.Server` with
 * Socket.IO already attached and never listens itself.
 *
 * Reached through `api/index.js`, a one-line re-export of the compiled output,
 * rather than through Vercel's Express auto-detection. That detection picks
 * the first of several candidate filenames that exists, and `src/app.ts` comes
 * before `src/server.ts` in its list — but `app.ts` builds the Express app and
 * nothing else, so detection would deploy a backend with no Socket.IO server,
 * no database connection check and no Redis connection.
 *
 * Connections are established before the module finishes loading, as in
 * `server.ts`, and for the same reasons. A bad DATABASE_URL or REDIS_URL fails
 * the cold start loudly instead of the first real request. And Redis must be
 * connected before anything uses it: the shared client is configured to fail
 * fast rather than queue, so a command issued while it is still connecting is
 * rejected — the first rate-limit check on every cold start would fail.
 */
await connectDatabase();
await connectRedis();

const httpServer = createServer(createApp());
createSocketServer(httpServer);

export default httpServer;
