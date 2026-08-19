import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// The readiness probe hits Postgres and Redis. Those are stubbed so the test
// asserts the endpoint's own contract (status codes, envelope, dependency
// reporting) rather than the availability of local infrastructure.
vi.mock("../src/database/prisma.js", () => ({
  checkDatabaseConnection: vi.fn(),
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
  prisma: {},
}));

vi.mock("../src/config/redis.js", () => ({
  checkRedisConnection: vi.fn(),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  redis: { call: vi.fn() },
  createRedisClient: vi.fn(),
}));

const { createApp } = await import("../src/app.js");
const { checkDatabaseConnection } = await import("../src/database/prisma.js");
const { checkRedisConnection } = await import("../src/config/redis.js");

const app = createApp();

describe("GET /health (liveness)", () => {
  it("reports the process is up without touching dependencies", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      error: null,
      data: { status: "ok" },
    });
    expect(typeof response.body.data.uptimeSeconds).toBe("number");
  });

  it("stays up even when dependencies are down", async () => {
    vi.mocked(checkDatabaseConnection).mockResolvedValue(false);
    vi.mocked(checkRedisConnection).mockResolvedValue(false);

    // Liveness must not depend on Postgres/Redis, otherwise an orchestrator
    // would kill a healthy container during a transient DB outage.
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
  });
});

describe("GET /ready (readiness)", () => {
  it("returns 200 and marks dependencies up when both are reachable", async () => {
    vi.mocked(checkDatabaseConnection).mockResolvedValue(true);
    vi.mocked(checkRedisConnection).mockResolvedValue(true);

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      status: "ready",
      dependencies: { database: "up", redis: "up" },
    });
  });

  it("returns 503 when the database is unreachable", async () => {
    vi.mocked(checkDatabaseConnection).mockResolvedValue(false);
    vi.mocked(checkRedisConnection).mockResolvedValue(true);

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns 503 when Redis is unreachable", async () => {
    vi.mocked(checkDatabaseConnection).mockResolvedValue(true);
    vi.mocked(checkRedisConnection).mockResolvedValue(false);

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });
});
