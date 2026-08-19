import { PrismaClient } from "@prisma/client";

import { isDevelopment } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Single PrismaClient for the process. Prisma manages its own connection
 * pool, so creating more than one client would multiply pool sizes against
 * Postgres' connection limit.
 *
 * In development, `tsx watch` re-imports modules on every save; caching the
 * client on `globalThis` prevents leaking a new pool per reload.
 */

/**
 * Built via a factory so the `log` literal types survive inference — the
 * typed `$on("error" | "warn")` overloads come from that generic, and a bare
 * `PrismaClient` annotation would erase them.
 */
function createPrismaClient() {
  return new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
    ],
  });
}

type AppPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma: AppPrismaClient = globalForPrisma.prisma ?? createPrismaClient();

prisma.$on("error", (event) => {
  logger.error({ target: event.target }, event.message);
});

prisma.$on("warn", (event) => {
  logger.warn({ target: event.target }, event.message);
});

if (isDevelopment) {
  globalForPrisma.prisma = prisma;
}

/** Verifies the connection is live. Used by `/ready` and at startup. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error({ err: error }, "Database health check failed");
    return false;
  }
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info("PostgreSQL connected");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info("PostgreSQL disconnected");
}
