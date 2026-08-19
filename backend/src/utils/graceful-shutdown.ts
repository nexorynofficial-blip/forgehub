import type { Server as HttpServer } from "node:http";

import { env } from "../config/env.js";
import { disconnectDatabase } from "../database/prisma.js";
import { logger } from "../utils/logger.js";
import { disconnectRedis } from "../config/redis.js";
import { closeSocketServer } from "../sockets/socket.js";

/**
 * Graceful shutdown.
 *
 * Order matters: stop accepting new connections first, then close sockets,
 * then release backing services. Draining in the other order would let an
 * in-flight request hit an already-closed database handle.
 */

let shuttingDown = false;

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      // Socket.IO's `close()` also tears down the HTTP server it is attached
      // to, so by this point the server is often already closed. That is the
      // desired end state, not a failure — anything else is a real error.
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
  logger.info("HTTP server closed");
}

async function shutdown(server: HttpServer, signal: string): Promise<void> {
  // A second SIGTERM while draining should not restart the sequence.
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, "Shutdown initiated");

  // Hard ceiling: if draining stalls (a hung keep-alive socket), exit anyway
  // rather than hanging until the orchestrator SIGKILLs us.
  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await closeSocketServer();
    await closeHttpServer(server);
    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);

    clearTimeout(forceExit);
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
}

export function registerShutdownHandlers(server: HttpServer): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(server, signal);
    });
  }

  // An unhandled rejection or uncaught exception leaves the process in an
  // undefined state — log it, then drain and let the orchestrator restart us.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    void shutdown(server, "unhandledRejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    void shutdown(server, "uncaughtException");
  });
}
