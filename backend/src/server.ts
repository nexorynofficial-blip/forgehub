import { createServer } from "node:http";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./database/prisma.js";
import { logger } from "./utils/logger.js";
import { connectRedis } from "./config/redis.js";
import { createSocketServer } from "./sockets/socket.js";
import { registerShutdownHandlers } from "./utils/graceful-shutdown.js";

/**
 * Process entrypoint: verify dependencies, then start listening.
 *
 * Connecting before binding the port means the process fails fast on a bad
 * DATABASE_URL/REDIS_URL instead of coming up "healthy" and 500-ing on the
 * first real request.
 */
async function bootstrap(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  const app = createApp();
  const httpServer = createServer(app);

  createSocketServer(httpServer);
  registerShutdownHandlers(httpServer);

  httpServer.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, host: env.HOST, env: env.NODE_ENV },
      `ForgeHub backend listening on http://${env.HOST}:${env.PORT}`,
    );
  });
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, "Failed to start server");
  process.exit(1);
});
