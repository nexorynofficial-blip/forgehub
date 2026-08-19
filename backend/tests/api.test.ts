import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/database/prisma.js", () => ({
  checkDatabaseConnection: vi.fn().mockResolvedValue(true),
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
  prisma: {},
}));

vi.mock("../src/config/redis.js", () => ({
  checkRedisConnection: vi.fn().mockResolvedValue(true),
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  redis: { call: vi.fn() },
  createRedisClient: vi.fn(),
}));

const { createApp } = await import("../src/app.js");

const app = createApp();

describe("API versioning", () => {
  it("mounts v1 at /api/v1", async () => {
    const response = await request(app).get("/api/v1");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      error: null,
      data: { version: "v1", status: "operational" },
    });
  });

  it("does not serve the API at an unversioned path", async () => {
    // Guards against a future refactor accidentally mounting routers at /api,
    // which would leave clients with no version to pin to.
    const response = await request(app).get("/api");
    expect(response.status).toBe(404);
  });
});

describe("Error handling", () => {
  it("returns the standard error envelope for unknown routes", async () => {
    const response = await request(app).get("/api/v1/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      data: null,
      error: { code: "NOT_FOUND" },
    });
    expect(typeof response.body.error.message).toBe("string");
  });

  it("never leaks a stack trace in the response body", async () => {
    const response = await request(app).get("/api/v1/does-not-exist");

    expect(response.body).not.toHaveProperty("stack");
    expect(JSON.stringify(response.body)).not.toContain("at ");
  });

  it("rejects malformed JSON with a 400 rather than crashing", async () => {
    const response = await request(app)
      .post("/api/v1/anything")
      .set("Content-Type", "application/json")
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("Security headers", () => {
  it("sets Helmet headers and removes the framework fingerprint", async () => {
    const response = await request(app).get("/health");

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBeDefined();
  });

  it("assigns a correlation id to every response", async () => {
    const response = await request(app).get("/health");
    expect(response.headers["x-request-id"]).toBeDefined();
  });

  it("echoes an upstream correlation id instead of replacing it", async () => {
    const response = await request(app)
      .get("/health")
      .set("X-Request-Id", "upstream-trace-id");

    expect(response.headers["x-request-id"]).toBe("upstream-trace-id");
  });
});

describe("CORS", () => {
  it("allows the configured frontend origin", async () => {
    const response = await request(app)
      .get("/api/v1")
      .set("Origin", "http://localhost:3000");

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("rejects an origin that is not on the allowlist", async () => {
    const response = await request(app)
      .get("/api/v1")
      .set("Origin", "http://evil.example.com");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");
  });
});

describe("Response envelope (TRD §7)", () => {
  it("carries success, data, message, and a null error on success", async () => {
    const response = await request(app).get("/api/v1");

    // The envelope is a superset: `success`/`message` satisfy the backend TRD,
    // while `data`/`error` satisfy the frontend's existing ApiResponse type.
    expect(response.body).toMatchObject({
      success: true,
      error: null,
    });
    expect(typeof response.body.message).toBe("string");
    expect(response.body.data).toBeDefined();
  });

  it("carries success, a null data, and a coded error on failure", async () => {
    const response = await request(app).get("/api/v1/nope");

    expect(response.body).toMatchObject({ success: false, data: null });
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("OpenAPI documentation (TRD §31)", () => {
  it("serves the OpenAPI document", async () => {
    const response = await request(app).get("/api/v1/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.1.0");
    expect(response.body.info.title).toBe("ForgeHub API");
  });

  it("documents the full error-code vocabulary clients branch on", async () => {
    const response = await request(app).get("/api/v1/openapi.json");
    const codes = response.body.components.schemas.ErrorEnvelope.properties.error
      .properties.code.enum as string[];

    // The eight categories named in TRD §16 must all be documented.
    expect(codes).toEqual(
      expect.arrayContaining([
        "VALIDATION_ERROR",
        "AUTHENTICATION_ERROR",
        "AUTHORIZATION_ERROR",
        "NOT_FOUND",
        "CONFLICT",
        "RATE_LIMITED",
        "DATABASE_ERROR",
        "INTERNAL_ERROR",
      ]),
    );
  });
});
