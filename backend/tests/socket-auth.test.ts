import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Socket.IO handshake authentication (BACKEND_TRD.md §20).
 *
 * Runs against a real listening server and a real client, because the thing
 * being tested is the handshake itself — a unit test of the middleware would
 * not prove that an unauthenticated socket is actually refused a connection.
 *
 * The rule §20 states is the one these assert: identity comes from the
 * verified token, never from anything the client claims about itself.
 */

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: () => Promise.resolve(),
    sendPasswordResetEmail: () => Promise.resolve(),
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/database/prisma.js");
const { connectRedis, redis } = await import("../src/config/redis.js");
const { createSocketServer, closeSocketServer, getSocketServer } =
  await import("../src/sockets/socket.js");
const { userRoom } = await import("../src/sockets/auth.socket.js");

const app = createApp();

const NS = "socktest";
const PASSWORD = "ValidPass123";

let httpServer: HttpServer;
let port: number;
let counter = 0;

function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  email: string;
  accessToken: string;
}

async function createUser(): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Socket Tester",
      email,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      agreeToTerms: true,
    })
    .expect(201);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return {
    email,
    userId: login.body.data.user.id as string,
    accessToken: login.body.data.accessToken as string,
  };
}

/** Resolves on connect, rejects with the handshake error otherwise. */
function connect(options: Parameters<typeof createClient>[1]): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${String(port)}`, {
    transports: ["websocket"],
    reconnection: false,
    ...options,
  });

  return new Promise((resolve, reject) => {
    socket.on("connect", () => {
      resolve(socket);
    });
    socket.on("connect_error", (error: Error) => {
      socket.close();
      reject(error);
    });
  });
}

beforeAll(async () => {
  await connectRedis();

  httpServer = createServer(app);
  createSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeSocketServer();
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });

  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

describe("Socket handshake authentication", () => {
  it("accepts a connection carrying a valid access token", async () => {
    const user = await createUser();
    const socket = await connect({ auth: { token: user.accessToken } });

    expect(socket.connected).toBe(true);
    socket.close();
  });

  it("accepts the token from an Authorization header too", async () => {
    const user = await createUser();
    const socket = await connect({
      extraHeaders: { Authorization: `Bearer ${user.accessToken}` },
    });

    expect(socket.connected).toBe(true);
    socket.close();
  });

  it("refuses a connection with no token at all", async () => {
    await expect(connect({})).rejects.toThrow(/authentication required/i);
  });

  it("refuses a connection with a forged token", async () => {
    await expect(connect({ auth: { token: "not-a-real-token" } })).rejects.toThrow(
      /invalid or expired/i,
    );
  });

  it("ignores a client-supplied userId — identity comes from the token", async () => {
    const [victim, attacker] = await Promise.all([createUser(), createUser()]);

    // The classic §20 mistake: trusting `handshake.auth.userId`. The socket
    // connects as the *token holder*, and the impersonation attempt is inert.
    const socket = await connect({
      auth: { token: attacker.accessToken, userId: victim.userId },
    });

    const server = getSocketServer();
    const attackerRoom = await server.in(userRoom(attacker.userId)).fetchSockets();
    const victimRoom = await server.in(userRoom(victim.userId)).fetchSockets();

    expect(attackerRoom).toHaveLength(1);
    expect(victimRoom).toHaveLength(0);

    socket.close();
  });

  it("joins the room derived from the verified user id", async () => {
    const user = await createUser();
    const socket = await connect({ auth: { token: user.accessToken } });

    const members = await getSocketServer().in(userRoom(user.userId)).fetchSockets();

    expect(members).toHaveLength(1);
    expect(members[0]?.data).toMatchObject({ user: { id: user.userId } });

    socket.close();
  });

  it("refuses a token whose session has been revoked", async () => {
    const user = await createUser();

    await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .expect(200);

    // The REST API rejects this token; the socket layer must agree, or
    // logout would leave a live realtime channel behind.
    await expect(connect({ auth: { token: user.accessToken } })).rejects.toThrow(
      /session is no longer valid|invalid or expired/i,
    );
  });

  it("refuses a banned user mid-session", async () => {
    const user = await createUser();
    await prisma.user.update({
      where: { id: user.userId },
      data: { status: "banned" },
    });

    await expect(connect({ auth: { token: user.accessToken } })).rejects.toThrow(
      /suspended/i,
    );
  });

  it("surfaces a machine-readable code on rejection", async () => {
    try {
      await connect({});
      expect.unreachable("connection should have been refused");
    } catch (error) {
      // Lets a client tell "refresh and retry" apart from "sign in again".
      expect((error as { data?: { code?: string } }).data?.code).toBe(
        "AUTHENTICATION_ERROR",
      );
    }
  });
});
