import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real-time messaging over Socket.IO (BACKEND_TRD.md §19–20,
 * BACKEND_ARCHITECTURE.md §13–15).
 *
 * Runs against a real listening server and real clients, for the same reason
 * `socket-auth.test.ts` does: the subject is the transport, and a unit test of
 * a handler would not prove that an unauthorized frame is actually refused on
 * the wire.
 *
 * The security claims asserted here are the ones the brief lists as
 * non-negotiable — a spoofed user id is inert, a non-member cannot join, type
 * into, or send to a conversation, a blocked user is cut off mid-session, and
 * nothing is broadcast before it is persisted.
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
const { conversationRoom } = await import("../src/sockets/message.socket.js");
const { presenceKey, isOnline } = await import("../src/sockets/presence.socket.js");

const app = createApp();

const NS = "msgsock";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/messages";

let httpServer: HttpServer;
let port: number;
let counter = 0;

/** Every client opened in a test, closed after it so no socket leaks. */
const open: ClientSocket[] = [];

function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  username: string;
  token: string;
}

async function createUser(): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Socket Messenger",
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
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    token: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

async function openConversation(actor: TestUser, other: TestUser): Promise<string> {
  const response = await request(app)
    .post(`${BASE}/conversations`)
    .set(...bearer(actor.token))
    .send({ username: other.username });

  expect([200, 201]).toContain(response.status);
  return response.body.data.conversation.id as string;
}

/** Connects a client, tracking it for cleanup. Rejects on a handshake refusal. */
function connect(options: Parameters<typeof createClient>[1]): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${String(port)}`, {
    transports: ["websocket"],
    reconnection: false,
    ...options,
  });
  open.push(socket);

  return new Promise((resolve, reject) => {
    socket.on("connect", () => {
      resolve(socket);
    });
    socket.on("connect_error", (error: Error) => {
      reject(error);
    });
  });
}

function connectAs(user: TestUser): Promise<ClientSocket> {
  return connect({ auth: { token: user.token } });
}

type Ack<T> =
  { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Emits and resolves with the acknowledgement, with a bounded wait. */
function emit<T>(socket: ClientSocket, event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no acknowledgement for ${event}`));
    }, 8_000);

    socket.emit(event, payload, (response: Ack<T>) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Resolves with the next occurrence of an event, or null if none arrives. */
function nextEvent<T>(
  socket: ClientSocket,
  event: string,
  ms = 1_500,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);

    function handler(payload: T): void {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.once(event, handler);
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
}, 60_000);

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
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
    await Promise.all(ids.map((id) => redis.del(presenceKey(id))));

    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: { in: ids } } } },
      select: { id: true },
    });
    await prisma.conversation.deleteMany({
      where: { id: { in: conversations.map((row) => row.id) } },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Handshake and rooms ─────────────────────────────────────────────────── */

describe("handshake", () => {
  it("connects with a valid token and joins the user room", async () => {
    const user = await createUser();
    const socket = await connectAs(user);

    expect(socket.connected).toBe(true);

    const members = await getSocketServer().in(userRoom(user.userId)).fetchSockets();
    expect(members).toHaveLength(1);
  });

  it("refuses an unauthenticated socket", async () => {
    await expect(connect({})).rejects.toThrow(/authentication required/i);
  });

  it("ignores a client-supplied userId in the handshake", async () => {
    const victim = await createUser();
    const attacker = await createUser();

    await connect({ auth: { token: attacker.token, userId: victim.userId } });

    const server = getSocketServer();
    expect(await server.in(userRoom(attacker.userId)).fetchSockets()).toHaveLength(1);
    expect(await server.in(userRoom(victim.userId)).fetchSockets()).toHaveLength(0);
  });
});

describe("conversation rooms", () => {
  it("lets a member join", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(a);
    const ack = await emit(socket, "conversation:join", { conversationId });

    expect(ack.ok).toBe(true);
    const members = await getSocketServer()
      .in(conversationRoom(conversationId))
      .fetchSockets();
    expect(members).toHaveLength(1);
  });

  it("refuses a non-member with the same non-disclosure as REST", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(outsider);
    const ack = await emit(socket, "conversation:join", { conversationId });

    expect(ack).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Conversation not found" },
    });

    // Crucially, the refusal is not merely an error message — the socket is
    // not in the room.
    const members = await getSocketServer()
      .in(conversationRoom(conversationId))
      .fetchSockets();
    expect(members).toHaveLength(0);
  });

  it("refuses a malformed payload", async () => {
    const user = await createUser();
    const socket = await connectAs(user);

    const ack = await emit(socket, "conversation:join", { conversationId: "nope" });
    expect(ack.ok).toBe(false);
  });
});

/* ── message:send ────────────────────────────────────────────────────────── */

describe("message:send", () => {
  it("persists and delivers to the other participant", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const senderSocket = await connectAs(a);
    const receiverSocket = await connectAs(b);

    const received = nextEvent<{ message: { id: string; content: string } }>(
      receiverSocket,
      "message:new",
    );

    const ack = await emit<{ message: { id: string } }>(senderSocket, "message:send", {
      conversationId,
      content: "over the wire",
    });

    expect(ack.ok).toBe(true);

    const event = await received;
    expect(event?.message.content).toBe("over the wire");

    // Persistence is the precondition for the emit, not a follow-up.
    const row = await prisma.message.findUnique({
      where: { id: event?.message.id ?? "" },
      select: { content: true },
    });
    expect(row?.content).toBe("over the wire");
  });

  it("delivers to the sender's own other devices", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const laptop = await connectAs(a);
    const phone = await connectAs(a);

    const onPhone = nextEvent<{ message: { content: string } }>(phone, "message:new");
    await emit(laptop, "message:send", { conversationId, content: "sync me" });

    expect((await onPhone)?.message.content).toBe("sync me");
  });

  it("does not deliver to anyone outside the conversation", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const senderSocket = await connectAs(a);
    const outsiderSocket = await connectAs(outsider);

    const leaked = nextEvent(outsiderSocket, "message:new");
    await emit(senderSocket, "message:send", { conversationId, content: "private" });

    expect(await leaked).toBeNull();
  });

  it("refuses a send into a conversation the socket does not belong to", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(outsider);
    const ack = await emit(socket, "message:send", {
      conversationId,
      content: "let me in",
    });

    expect(ack.ok).toBe(false);
    expect(ack.ok === false && ack.error.code).toBe("NOT_FOUND");

    const count = await prisma.message.count({ where: { conversationId } });
    expect(count).toBe(0);
  });

  it("ignores a senderId in the frame", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(a);
    const ack = await emit<{ message: { senderId: string } }>(socket, "message:send", {
      conversationId,
      content: "whose is this?",
      senderId: b.userId,
      userId: b.userId,
    });

    expect(ack.ok === true && ack.data.message.senderId).toBe(a.userId);
  });

  it("persists nothing when validation fails", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(a);
    const ack = await emit(socket, "message:send", { conversationId, content: "" });

    expect(ack.ok).toBe(false);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("emits nothing when the send is refused", async () => {
    // "Do not emit a successful message before persistence succeeds" — the
    // stronger version: a refused send emits nothing at all.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const receiverSocket = await connectAs(b);
    const outsider = await createUser();
    const outsiderSocket = await connectAs(outsider);

    const leaked = nextEvent(receiverSocket, "message:new");
    await emit(outsiderSocket, "message:send", { conversationId, content: "forged" });

    expect(await leaked).toBeNull();
  });

  it("still persists when the recipient is offline", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    // b never connects.
    const socket = await connectAs(a);
    const ack = await emit(socket, "message:send", {
      conversationId,
      content: "read this later",
    });

    expect(ack.ok).toBe(true);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(b.token))
      .expect(200);

    expect(response.body.data.items[0].content).toBe("read this later");

    const unread = await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(b.token))
      .expect(200);
    expect(unread.body.data.unreadCount).toBe(1);
  });

  it("cuts off a blocked sender mid-session", async () => {
    // Room membership is not proof of authorization: the socket joined while
    // permitted, and the block must take effect on the very next frame.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(a);
    await emit(socket, "conversation:join", { conversationId });
    expect(
      (await emit(socket, "message:send", { conversationId, content: "ok" })).ok,
    ).toBe(true);

    await request(app)
      .post(`/api/v1/users/${a.username}/block`)
      .set(...bearer(b.token))
      .expect(201);

    const ack = await emit(socket, "message:send", {
      conversationId,
      content: "after the block",
    });

    expect(ack.ok).toBe(false);
    expect(ack.ok === false && ack.error.code).toBe("NOT_FOUND");
  });
});

/* ── message:read ────────────────────────────────────────────────────────── */

describe("message:read", () => {
  it("moves the caller's watermark and tells the other side", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const senderSocket = await connectAs(a);
    const readerSocket = await connectAs(b);

    await emit(senderSocket, "message:send", { conversationId, content: "seen yet?" });

    const receipt = nextEvent<{ userId: string; lastReadAt: string | null }>(
      senderSocket,
      "message:read",
    );

    const ack = await emit<{ unreadCount: number }>(readerSocket, "message:read", {
      conversationId,
    });

    expect(ack.ok === true && ack.data.unreadCount).toBe(0);
    expect((await receipt)?.userId).toBe(b.userId);
  });

  it("moves only the caller's watermark, whatever the frame claims", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const senderSocket = await connectAs(a);
    await emit(senderSocket, "message:send", { conversationId, content: "for b" });

    await emit(senderSocket, "message:read", { conversationId, userId: b.userId });

    const membership = await prisma.conversationMember.findFirstOrThrow({
      where: { conversationId, userId: b.userId },
      select: { lastReadAt: true },
    });
    expect(membership.lastReadAt).toBeNull();
  });

  it("refuses a read on a conversation the socket does not belong to", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(outsider);
    const ack = await emit(socket, "message:read", { conversationId });

    expect(ack.ok).toBe(false);
  });
});

/* ── Typing indicators ───────────────────────────────────────────────────── */

describe("typing indicators", () => {
  it("relays typing to another member in the room", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const typerSocket = await connectAs(a);
    const watcherSocket = await connectAs(b);

    await emit(typerSocket, "conversation:join", { conversationId });
    await emit(watcherSocket, "conversation:join", { conversationId });

    const seen = nextEvent<{ userId: string; conversationId: string }>(
      watcherSocket,
      "message:typing",
    );

    await emit(typerSocket, "message:typing", { conversationId });

    const event = await seen;
    expect(event?.userId).toBe(a.userId);
    expect(event?.conversationId).toBe(conversationId);
  });

  it("relays stop_typing too", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const typerSocket = await connectAs(a);
    const watcherSocket = await connectAs(b);
    await emit(typerSocket, "conversation:join", { conversationId });
    await emit(watcherSocket, "conversation:join", { conversationId });

    const seen = nextEvent<{ userId: string }>(watcherSocket, "message:stop_typing");
    await emit(typerSocket, "message:stop_typing", { conversationId });

    expect((await seen)?.userId).toBe(a.userId);
  });

  it("does not echo typing back to the typist", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const typerSocket = await connectAs(a);
    await emit(typerSocket, "conversation:join", { conversationId });

    const echoed = nextEvent(typerSocket, "message:typing");
    await emit(typerSocket, "message:typing", { conversationId });

    expect(await echoed).toBeNull();
  });

  it("overwrites a spoofed userId with the handshake identity", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const typerSocket = await connectAs(a);
    const watcherSocket = await connectAs(b);
    await emit(typerSocket, "conversation:join", { conversationId });
    await emit(watcherSocket, "conversation:join", { conversationId });

    const seen = nextEvent<{ userId: string }>(watcherSocket, "message:typing");
    await emit(typerSocket, "message:typing", { conversationId, userId: b.userId });

    // The relayed event names the *token holder*, not the claimed user, so a
    // socket cannot make someone else appear to be typing.
    expect((await seen)?.userId).toBe(a.userId);
  });

  it("refuses typing into a conversation the socket does not belong to", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const watcherSocket = await connectAs(b);
    await emit(watcherSocket, "conversation:join", { conversationId });

    const outsiderSocket = await connectAs(outsider);
    const leaked = nextEvent(watcherSocket, "message:typing");

    const ack = await emit(outsiderSocket, "message:typing", { conversationId });

    expect(ack.ok).toBe(false);
    expect(await leaked).toBeNull();
  });

  it("persists nothing", async () => {
    // Typing is ephemeral by specification. Nothing in this path may write.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const socket = await connectAs(a);
    await emit(socket, "conversation:join", { conversationId });
    await emit(socket, "message:typing", { conversationId });
    await emit(socket, "message:stop_typing", { conversationId });

    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });
});

/* ── Presence ────────────────────────────────────────────────────────────── */

describe("presence", () => {
  it("marks a user online on connect and offline on disconnect", async () => {
    const user = await createUser();

    const socket = await connectAs(user);
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(true);
    });

    socket.close();
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(false);
    });
  });

  it("keeps a user online while another tab remains connected", async () => {
    // The bug the brief names explicitly: one tab closing must not mark a
    // user offline while another socket is still live.
    const user = await createUser();

    const laptop = await connectAs(user);
    const phone = await connectAs(user);

    await vi.waitFor(async () => {
      expect(await redis.scard(presenceKey(user.userId))).toBe(2);
    });

    laptop.close();

    await vi.waitFor(async () => {
      expect(await redis.scard(presenceKey(user.userId))).toBe(1);
    });
    expect(await isOnline(user.userId)).toBe(true);

    phone.close();
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(false);
    });
  });

  it("gives the presence key a TTL so a crashed process cannot strand it", async () => {
    const user = await createUser();
    await connectAs(user);

    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(true);
    });

    const ttl = await redis.ttl(presenceKey(user.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("tells a conversation partner when someone comes online", async () => {
    const a = await createUser();
    const b = await createUser();
    await openConversation(a, b);

    const watcher = await connectAs(b);
    const seen = nextEvent<{ userId: string; online: boolean }>(
      watcher,
      "user:online",
      4_000,
    );

    await connectAs(a);

    const event = await seen;
    expect(event?.userId).toBe(a.userId);
    expect(event?.online).toBe(true);
  });

  it("does not announce presence to unrelated users", async () => {
    const a = await createUser();
    const unrelated = await createUser();

    const watcher = await connectAs(unrelated);
    const leaked = nextEvent(watcher, "user:online", 1_500);

    await connectAs(a);

    // Presence goes to conversation partners, not to everyone connected.
    expect(await leaked).toBeNull();
  });

  it("survives a reconnect", async () => {
    const user = await createUser();

    const first = await connectAs(user);
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(true);
    });

    first.close();
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(false);
    });

    await connectAs(user);
    await vi.waitFor(async () => {
      expect(await isOnline(user.userId)).toBe(true);
    });
  });
});

/* ── REST and socket agree ───────────────────────────────────────────────── */

describe("cross-transport delivery", () => {
  it("delivers a REST-sent message to an open socket", async () => {
    // A sender with no socket open must still reach a recipient in real time;
    // real-time delivery cannot depend on which transport the sender used.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const receiverSocket = await connectAs(b);
    const received = nextEvent<{ message: { content: string } }>(
      receiverSocket,
      "message:new",
    );

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "sent over http" })
      .expect(201);

    expect((await received)?.message.content).toBe("sent over http");
  });

  it("delivers a REST read receipt to an open socket", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const senderSocket = await connectAs(a);
    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "tick please" })
      .expect(201);

    const receipt = nextEvent<{ userId: string }>(senderSocket, "message:read");

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(b.token))
      .send({})
      .expect(200);

    expect((await receipt)?.userId).toBe(b.userId);
  });
});
