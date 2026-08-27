import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Notification security regressions (TRD §20 posture, ARCHITECTURE §16).
 *
 * A notification list is a digest of everything one person has received —
 * every like, mention, invitation, and message. Reading someone else's is
 * closer to reading their inbox than to reading their profile, so this file
 * treats it that way.
 *
 * Three properties are asserted throughout:
 *
 *   1. **The recipient is the token holder, always.** No body, query, or path
 *      value selects whose notifications are read or mutated.
 *   2. **Refusals do not disclose.** A notification belonging to someone else
 *      and one that never existed answer identically.
 *   3. **Blocking suppresses.** A blocked actor cannot put text in front of
 *      the person who blocked them, through any trigger.
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

const app = createApp();

const NS = "notifsec";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/notifications";

let counter = 0;
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
      displayName: "Security Tester",
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

async function follow(actor: TestUser, target: TestUser): Promise<void> {
  await request(app)
    .post(`/api/v1/users/${target.username}/follow`)
    .set(...bearer(actor.token))
    .expect(201);
}

async function block(actor: TestUser, target: TestUser): Promise<void> {
  await request(app)
    .post(`/api/v1/users/${target.username}/block`)
    .set(...bearer(actor.token))
    .expect(201);
}

async function listFor(user: TestUser) {
  const response = await request(app)
    .get(BASE)
    .set(...bearer(user.token))
    .expect(200);
  return response.body.data;
}

/** A recipient holding exactly one notification, plus its id. */
async function withNotification(): Promise<{ recipient: TestUser; id: string }> {
  const [recipient, actor] = [await createUser(), await createUser()];
  await follow(actor, recipient);
  const id = (await listFor(recipient)).items[0].id as string;
  return { recipient, id };
}

beforeAll(async () => {
  await connectRedis();
}, 60_000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Cross-user isolation ────────────────────────────────────────────────── */

describe("a user cannot reach another user's notifications", () => {
  it("sees only their own list", async () => {
    const { recipient, id } = await withNotification();
    const outsider = await createUser();

    const theirs = await listFor(outsider);
    expect(theirs.items).toEqual([]);
    expect(theirs.unreadCount).toBe(0);

    // And the recipient's row is genuinely there, so the empty list above is
    // isolation rather than nothing having happened.
    expect((await listFor(recipient)).items[0].id).toBe(id);
  });

  it("404s marking someone else's notification read", async () => {
    const { id } = await withNotification();
    const outsider = await createUser();

    const response = await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(outsider.token))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("404s a nonexistent notification identically", async () => {
    // Indistinguishable from the case above: a 403 there would confirm the id
    // belongs to somebody, which is what an enumeration attack wants.
    const outsider = await createUser();

    const response = await request(app)
      .post(`${BASE}/00000000-0000-4000-8000-000000000000/read`)
      .set(...bearer(outsider.token))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("leaves the notification unread after a refused mark", async () => {
    const { recipient, id } = await withNotification();
    const outsider = await createUser();

    await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(outsider.token))
      .expect(404);

    expect((await listFor(recipient)).unreadCount).toBe(1);
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id },
      select: { isRead: true },
    });
    expect(row.isRead).toBe(false);
  });

  it("marks all read only for the caller", async () => {
    const { recipient } = await withNotification();
    const other = await withNotification();

    await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(recipient.token))
      .expect(200);

    expect((await listFor(other.recipient)).unreadCount).toBe(1);
  });
});

/* ── Client-supplied identity is ignored ─────────────────────────────────── */

describe("client-supplied identity is ignored", () => {
  it("ignores a userId in the list query", async () => {
    const { recipient } = await withNotification();
    const outsider = await createUser();

    const response = await request(app)
      .get(BASE)
      .query({ userId: recipient.userId, recipientId: recipient.userId })
      .set(...bearer(outsider.token))
      .expect(200);

    expect(response.body.data.items).toEqual([]);
  });

  it("ignores a userId in the mark-all body", async () => {
    const { recipient } = await withNotification();
    const outsider = await createUser();

    await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(outsider.token))
      .send({ userId: recipient.userId })
      .expect(200);

    expect((await listFor(recipient)).unreadCount).toBe(1);
  });

  it("ignores a userId in the mark-one body", async () => {
    const { recipient, id } = await withNotification();
    const outsider = await createUser();

    await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(outsider.token))
      .send({ userId: recipient.userId })
      .expect(404);

    expect((await listFor(recipient)).unreadCount).toBe(1);
  });

  it("cannot forge an actorId on a trigger", async () => {
    // The actor is the token holder at every call site, so a spoofed field is
    // stripped by Zod long before it reaches the port.
    const [recipient, actor, victim] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .send({ actorId: victim.userId, userId: victim.userId })
      .expect(201);

    const notification = (await listFor(recipient)).items[0];
    expect(notification.actorId).toBe(actor.userId);
    expect(notification.actorId).not.toBe(victim.userId);
  });

  it("offers no endpoint for creating a notification", async () => {
    // Notifications are server-generated. A create endpoint would be a way to
    // write arbitrary text into someone else's panel.
    const attacker = await createUser();
    const victim = await createUser();

    const response = await request(app)
      .post(BASE)
      .set(...bearer(attacker.token))
      .send({
        userId: victim.userId,
        type: "moderation",
        message: "Your account has been suspended. Click here.",
      });

    expect([404, 405]).toContain(response.status);
    expect(await prisma.notification.count({ where: { userId: victim.userId } })).toBe(0);
  });
});

/* ── Blocking ────────────────────────────────────────────────────────────── */

describe("blocking suppresses notifications", () => {
  it("suppresses when the recipient blocked the actor", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    await block(recipient, actor);

    // The follow itself is refused by Phase 4, so use a trigger that survives:
    // a like on a post the blocked user can still reach is the tighter test.
    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(recipient.token))
      .send({ type: "text", content: "a post by someone who blocked you" })
      .expect(201);

    // Phase 4 blocking already hides the post from the blocked actor, so the
    // like is refused — and no notification is produced either way.
    await request(app)
      .post(`/api/v1/posts/${post.body.data.post.id as string}/like`)
      .set(...bearer(actor.token))
      .expect(404);

    expect((await listFor(recipient)).items).toEqual([]);
  });

  it("suppresses a notification when a block lands after the relationship", async () => {
    // The interesting case: the actor was permitted at the time, and the block
    // must close the channel for events that follow it.
    const [recipient, actor] = [await createUser(), await createUser()];
    await follow(actor, recipient);

    // Clear what the follow produced, then block.
    await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(recipient.token))
      .expect(200);
    await block(recipient, actor);

    const before = await prisma.notification.count({
      where: { userId: recipient.userId },
    });

    // Any later trigger from this actor must produce nothing.
    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token));

    expect(await prisma.notification.count({ where: { userId: recipient.userId } })).toBe(
      before,
    );
  });

  it("suppresses in the other block direction too", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    await follow(actor, recipient);
    await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(recipient.token))
      .expect(200);

    // This time the *actor* does the blocking.
    await block(actor, recipient);

    const before = await prisma.notification.count({
      where: { userId: recipient.userId },
    });
    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token));

    expect(await prisma.notification.count({ where: { userId: recipient.userId } })).toBe(
      before,
    );
  });
});

/* ── Self-notification ───────────────────────────────────────────────────── */

describe("self-notification is suppressed", () => {
  it("does not notify you about liking your own post", async () => {
    const user = await createUser();
    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(user.token))
      .send({ type: "text", content: "my own post" })
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${post.body.data.post.id as string}/like`)
      .set(...bearer(user.token))
      .expect(201);

    expect((await listFor(user)).items).toEqual([]);
  });

  it("does not notify you about commenting on your own post", async () => {
    const user = await createUser();
    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(user.token))
      .send({ type: "text", content: "my own thread" })
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${post.body.data.post.id as string}/comments`)
      .set(...bearer(user.token))
      .send({ content: "replying to myself" })
      .expect(201);

    expect((await listFor(user)).items).toEqual([]);
  });

  it("does not notify you about mentioning yourself", async () => {
    const user = await createUser();

    await request(app)
      .post("/api/v1/posts")
      .set(...bearer(user.token))
      .send({ type: "text", content: `talking about @${user.username} here` })
      .expect(201);

    expect((await listFor(user)).items).toEqual([]);
  });
});

/* ── Authentication ──────────────────────────────────────────────────────── */

describe("no anonymous access", () => {
  it("401s every notification route", async () => {
    const { id } = await withNotification();

    const cases: [string, string][] = [
      ["get", BASE],
      ["get", `${BASE}/unread`],
      ["post", `${BASE}/read-all`],
      ["post", `${BASE}/${id}/read`],
    ];

    for (const [method, path] of cases) {
      const response = await (
        request(app) as unknown as Record<string, (url: string) => request.Test>
      )
        [method]?.(path)
        .send({});

      expect(response?.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it("401s with a forged token", async () => {
    await request(app)
      .get(BASE)
      .set("Authorization", "Bearer not-a-real-token")
      .expect(401);
  });
});

/* ── Platform admin has no special power ─────────────────────────────────── */

describe("admin role", () => {
  it("does not let an admin read another user's notifications", async () => {
    // A notification list is a digest of everything a user has received.
    // Phases 4–8 kept admin out of ordinary social surfaces; this is a more
    // sensitive surface than any of them.
    const { recipient } = await withNotification();
    const admin = await createUser();

    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: "platform_admin" },
    });

    const email = await prisma.user.findUniqueOrThrow({
      where: { id: admin.userId },
      select: { email: true },
    });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: email.email, password: PASSWORD, rememberMe: false })
      .expect(200);

    const adminToken = login.body.data.accessToken as string;

    const response = await request(app)
      .get(BASE)
      .set(...bearer(adminToken))
      .expect(200);

    expect(response.body.data.items).toEqual([]);
    expect(recipient.userId).not.toBe(admin.userId);
  });
});
