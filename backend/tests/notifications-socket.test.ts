import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Real-time notification delivery (ARCHITECTURE §14, §16; TRD §19).
 *
 * Runs against a real listening server and real clients, for the same reason
 * `socket-auth.test.ts` and `messages-socket.test.ts` do: the subject is the
 * transport, and a unit test of an emitter would not prove that a notification
 * actually reaches one user's socket and no one else's.
 *
 * The two claims that matter most here:
 *
 *   1. **Isolation.** `notification:new` reaches the recipient's room and
 *      nobody else's, ever. The recipient is read off the persisted row, which
 *      the service resolved from a domain event — no client names a recipient
 *      at any point in the chain.
 *   2. **Offline survival.** §16 requires notifications to work when the
 *      recipient is offline, so persistence must not depend on a live socket
 *      and the row must be waiting when they reconnect.
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
const { createSocketServer, closeSocketServer } =
  await import("../src/sockets/socket.js");
const { presenceKey } = await import("../src/sockets/presence.socket.js");
const { NOTIFICATION_NEW_EVENT } = await import("../src/sockets/notification.socket.js");

const app = createApp();

const NS = "notifsock";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/notifications";

let httpServer: HttpServer;
let port: number;
let counter = 0;

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
      displayName: "Socket Notify",
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

function connect(token: string): Promise<ClientSocket> {
  const socket = createClient(`http://127.0.0.1:${String(port)}`, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token },
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

/** Resolves with the next occurrence of an event, or null if none arrives. */
function nextEvent<T>(
  socket: ClientSocket,
  event: string,
  ms = 2_500,
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

async function follow(actor: TestUser, target: TestUser): Promise<void> {
  await request(app)
    .post(`/api/v1/users/${target.username}/follow`)
    .set(...bearer(actor.token))
    .expect(201);
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
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Delivery ────────────────────────────────────────────────────────────── */

describe("notification:new", () => {
  it("reaches the recipient in real time", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    const socket = await connect(recipient.token);

    const received = nextEvent<{ notification: { type: string; message: string } }>(
      socket,
      NOTIFICATION_NEW_EVENT,
    );

    await follow(actor, recipient);

    const event = await received;
    expect(event?.notification.type).toBe("follower");
    expect(event?.notification.message).toContain("started following you");
  });

  it("carries the full projected notification, not a bare id", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    const socket = await connect(recipient.token);
    const received = nextEvent<{
      notification: { id: string; userId: string; actor: { username: string } | null };
    }>(socket, NOTIFICATION_NEW_EVENT);

    await follow(actor, recipient);

    const event = await received;
    expect(event?.notification.id).toBeTruthy();
    expect(event?.notification.userId).toBe(recipient.userId);
    expect(event?.notification.actor?.username).toBe(actor.username);
  });

  it("never reaches anyone else's socket", async () => {
    // The isolation property. The recipient is read off the persisted row, so
    // there is no parameter a client could tamper with to redirect delivery.
    const [recipient, actor, outsider] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];

    const recipientSocket = await connect(recipient.token);
    const outsiderSocket = await connect(outsider.token);

    const delivered = nextEvent(recipientSocket, NOTIFICATION_NEW_EVENT);
    const leaked = nextEvent(outsiderSocket, NOTIFICATION_NEW_EVENT, 1_500);

    await follow(actor, recipient);

    expect(await delivered).not.toBeNull();
    expect(await leaked).toBeNull();
  });

  it("does not echo back to the actor who caused it", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    const actorSocket = await connect(actor.token);

    const echoed = nextEvent(actorSocket, NOTIFICATION_NEW_EVENT, 1_500);
    await follow(actor, recipient);

    expect(await echoed).toBeNull();
  });

  it("reaches all of the recipient's own devices", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    const laptop = await connect(recipient.token);
    const phone = await connect(recipient.token);

    const onLaptop = nextEvent(laptop, NOTIFICATION_NEW_EVENT);
    const onPhone = nextEvent(phone, NOTIFICATION_NEW_EVENT);

    await follow(actor, recipient);

    expect(await onLaptop).not.toBeNull();
    expect(await onPhone).not.toBeNull();
  });

  it("emits for a like, a comment, and a mention alike", async () => {
    const [author, actor] = [await createUser(), await createUser()];
    const socket = await connect(author.token);

    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({ type: "text", content: "socket trigger coverage" })
      .expect(201);
    const postId = post.body.data.post.id as string;

    const onLike = nextEvent<{ notification: { type: string } }>(
      socket,
      NOTIFICATION_NEW_EVENT,
    );
    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(actor.token))
      .expect(201);
    expect((await onLike)?.notification.type).toBe("like");

    const onComment = nextEvent<{ notification: { type: string } }>(
      socket,
      NOTIFICATION_NEW_EVENT,
    );
    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(actor.token))
      .send({ content: "nice" })
      .expect(201);
    expect((await onComment)?.notification.type).toBe("comment");
  });
});

/* ── One payload shape, including the fan-out ────────────────────────────── */

describe("the fan-out uses the same payload as every other type", () => {
  /** Creates a project owned by `owner` and returns its slug. */
  async function createProject(owner: TestUser, title: string): Promise<string> {
    const response = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title, description: "A project with followers watching it." })
      .expect(201);
    return response.body.data.project.slug as string;
  }

  it("delivers a complete projection for project_update", async () => {
    // `project_update` is the only fan-out path, and it once emitted a
    // different frame — `{ notification: null, type, entityType, entityId }` —
    // because the batch insert returned no rows. A client would have had to
    // branch on which server-side write path produced the notification, so the
    // write now returns its rows and this asserts the frame is the ordinary one.
    const [owner, follower] = [await createUser(), await createUser()];
    const slug = await createProject(owner, "Socket Fanout");

    await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    const socket = await connect(follower.token);
    const received = nextEvent<{
      notification: {
        id: string;
        userId: string;
        type: string;
        entityType: string | null;
        targetId: string | null;
        message: string;
        isRead: boolean;
        readAt: string | null;
        createdAt: string;
        actor: { id: string; username: string } | null;
      } | null;
    }>(socket, NOTIFICATION_NEW_EVENT);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "The fan-out shipped a milestone." })
      .expect(201);

    const event = await received;
    const notification = event?.notification;

    expect(notification).not.toBeNull();
    expect(notification?.type).toBe("project_update");
    expect(notification?.userId).toBe(follower.userId);
    expect(notification?.id).toBeTruthy();
    expect(notification?.entityType).toBe("project");
    expect(notification?.targetId).toBeTruthy();
    expect(notification?.message).toContain("Socket Fanout");
    expect(notification?.isRead).toBe(false);
    expect(notification?.readAt).toBeNull();
    expect(typeof notification?.createdAt).toBe("string");
    expect(notification?.actor?.id).toBe(owner.userId);
    expect(notification?.actor?.username).toBe(owner.username);
  });

  it("emits the same keys for a fanned-out and a singly-created notification", async () => {
    // The contract stated as a property rather than a field list: whatever the
    // single-recipient path puts on the wire, the fan-out puts there too.
    const [owner, follower, actor] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const slug = await createProject(owner, "Key Parity");

    await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    const socket = await connect(follower.token);

    const fannedOut = nextEvent<{ notification: Record<string, unknown> }>(
      socket,
      NOTIFICATION_NEW_EVENT,
    );
    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "An update for the parity check." })
      .expect(201);
    const fanEvent = await fannedOut;

    const single = nextEvent<{ notification: Record<string, unknown> }>(
      socket,
      NOTIFICATION_NEW_EVENT,
    );
    await follow(actor, follower);
    const singleEvent = await single;

    expect(fanEvent).not.toBeNull();
    expect(singleEvent).not.toBeNull();
    expect(Object.keys(fanEvent?.notification ?? {}).sort()).toEqual(
      Object.keys(singleEvent?.notification ?? {}).sort(),
    );
    // And the envelope itself carries nothing beyond the notification.
    expect(Object.keys(fanEvent ?? {})).toEqual(["notification"]);
  });

  it("reaches only the followers, never an unrelated user", async () => {
    const [owner, follower, outsider] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const slug = await createProject(owner, "Fanout Isolation");

    await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    const followerSocket = await connect(follower.token);
    const outsiderSocket = await connect(outsider.token);

    const delivered = nextEvent(followerSocket, NOTIFICATION_NEW_EVENT);
    const leaked = nextEvent(outsiderSocket, NOTIFICATION_NEW_EVENT, 1_500);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "Only followers should see this." })
      .expect(201);

    expect(await delivered).not.toBeNull();
    expect(await leaked).toBeNull();
  });
});

/* ── Suppression produces no socket traffic ──────────────────────────────── */

describe("suppressed notifications emit nothing", () => {
  it("emits nothing when the type is muted", async () => {
    // Otherwise muting a type in settings would still make a badge flicker.
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(recipient.token))
      .send({ type: "follower", inApp: false })
      .expect(200);

    const socket = await connect(recipient.token);
    const emitted = nextEvent(socket, NOTIFICATION_NEW_EVENT, 1_500);

    await follow(actor, recipient);

    expect(await emitted).toBeNull();
  });

  it("emits nothing for a collapsed duplicate", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(recipient.token))
      .send({ type: "text", content: "collapse me" })
      .expect(201);
    const postId = post.body.data.post.id as string;

    const socket = await connect(recipient.token);

    const first = nextEvent(socket, NOTIFICATION_NEW_EVENT);
    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(actor.token))
      .expect(201);
    expect(await first).not.toBeNull();

    // Unlike and re-like: the second notification collapses into the unread
    // first, so nothing new goes on the wire.
    await request(app)
      .delete(`/api/v1/posts/${postId}/like`)
      .set(...bearer(actor.token))
      .expect(200);

    const second = nextEvent(socket, NOTIFICATION_NEW_EVENT, 1_500);
    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(actor.token))
      .expect(201);

    expect(await second).toBeNull();
  });

  it("emits nothing for a self-notification", async () => {
    const user = await createUser();
    const socket = await connect(user.token);
    const emitted = nextEvent(socket, NOTIFICATION_NEW_EVENT, 1_500);

    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(user.token))
      .send({ type: "text", content: "my own post" })
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${post.body.data.post.id as string}/like`)
      .set(...bearer(user.token))
      .expect(201);

    expect(await emitted).toBeNull();
  });
});

/* ── Offline recipients ──────────────────────────────────────────────────── */

describe("offline recipients", () => {
  it("persists the notification when nobody is connected", async () => {
    // ARCHITECTURE §16: notifications must work even when the recipient is
    // offline. Nothing here opens a socket for the recipient.
    const [recipient, actor] = [await createUser(), await createUser()];

    await follow(actor, recipient);

    const response = await request(app)
      .get(BASE)
      .set(...bearer(recipient.token))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.unreadCount).toBe(1);
  });

  it("hands the notification over on a later connect", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    await follow(actor, recipient);

    // The socket opens after the event; delivery is not replayed on connect,
    // and it does not need to be — the row is already there to fetch.
    await connect(recipient.token);

    const response = await request(app)
      .get(BASE)
      .set(...bearer(recipient.token))
      .expect(200);

    expect(response.body.data.items[0].type).toBe("follower");
  });

  it("does not fail the originating operation when delivery is impossible", async () => {
    // The port is fire-and-forget by contract. A follow succeeds whether or
    // not the other party ever hears about it.
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const profile = await request(app)
      .get(`/api/v1/users/${recipient.username}`)
      .set(...bearer(actor.token))
      .expect(200);

    expect(profile.body.data.relationship.isFollowing).toBe(true);
  });
});

/* ── No inbound surface ──────────────────────────────────────────────────── */

describe("the notification socket has no inbound events", () => {
  it("does not accept a mark-read frame", async () => {
    // Marking read is a REST call. A socket path for it would be a second
    // entry point into the same mutation, and a second place for the
    // ownership check to be missing.
    const [recipient, actor] = [await createUser(), await createUser()];
    await follow(actor, recipient);

    const socket = await connect(recipient.token);

    const acknowledged = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, 1_500);
      socket.emit("notification:read", { all: true }, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    expect(acknowledged).toBe(false);

    // And the notification is still unread, because nothing handled the frame.
    const response = await request(app)
      .get(`${BASE}/unread`)
      .set(...bearer(recipient.token))
      .expect(200);
    expect(response.body.data.unreadCount).toBe(1);
  });
});
