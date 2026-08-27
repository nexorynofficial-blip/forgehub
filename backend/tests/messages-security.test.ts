import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Messaging security regressions (BACKEND_TRD.md §20).
 *
 * Every case the brief names as something that "must fail safely", written as
 * an attack rather than as a feature: a client asserting someone else's
 * identity, a blocked user reaching for a conversation, a stranger reading,
 * typing into, editing, or reacting inside a thread that is not theirs.
 *
 * Two properties are asserted throughout, and they are the ones most likely to
 * regress quietly:
 *
 *   1. **Blocking outranks membership.** A conversation that predates a block
 *      must close for both parties, not merely refuse new sends.
 *   2. **Refusals do not disclose.** A blocked user, a "followers only" user,
 *      and a nonexistent user must be indistinguishable from outside.
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

const NS = "msgsec";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/messages";

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

async function openConversation(actor: TestUser, other: TestUser): Promise<string> {
  const response = await request(app)
    .post(`${BASE}/conversations`)
    .set(...bearer(actor.token))
    .send({ username: other.username });

  expect([200, 201]).toContain(response.status);
  return response.body.data.conversation.id as string;
}

async function sendMessage(
  actor: TestUser,
  conversationId: string,
  content: string,
): Promise<string> {
  const response = await request(app)
    .post(`${BASE}/conversations/${conversationId}/messages`)
    .set(...bearer(actor.token))
    .send({ content })
    .expect(201);

  return response.body.data.message.id as string;
}

async function block(actor: TestUser, target: TestUser): Promise<void> {
  await request(app)
    .post(`/api/v1/users/${target.username}/block`)
    .set(...bearer(actor.token))
    .expect(201);
}

async function follow(actor: TestUser, target: TestUser): Promise<void> {
  await request(app)
    .post(`/api/v1/users/${target.username}/follow`)
    .set(...bearer(actor.token))
    .expect(201);
}

async function setPolicy(actor: TestUser, whoCanMessage: string): Promise<void> {
  await request(app)
    .patch("/api/v1/users/me/settings")
    .set(...bearer(actor.token))
    .send({ whoCanMessage })
    .expect(200);
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

/* ── Identity spoofing ───────────────────────────────────────────────────── */

describe("client-supplied identity is ignored", () => {
  it("ignores a supplied senderId on send", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const response = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "spoofed?", senderId: b.userId })
      .expect(201);

    expect(response.body.data.message.senderId).toBe(a.userId);

    const row = await prisma.message.findUniqueOrThrow({
      where: { id: response.body.data.message.id as string },
      select: { senderId: true },
    });
    expect(row.senderId).toBe(a.userId);
  });

  it("ignores a supplied userId when marking read", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "for b");

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(a.token))
      .send({ userId: b.userId, memberId: b.userId })
      .expect(200);

    // b's watermark must be untouched: only the token holder's moves.
    const membership = await prisma.conversationMember.findFirstOrThrow({
      where: { conversationId, userId: b.userId },
      select: { lastReadAt: true },
    });
    expect(membership.lastReadAt).toBeNull();
  });

  it("ignores a supplied actorId when reacting", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "react");

    const response = await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(b.token))
      .send({ emoji: "👍", userId: a.userId, actorId: a.userId })
      .expect(201);

    expect(response.body.data.message.reactions[0].userIds).toEqual([b.userId]);
  });

  it("ignores a supplied conversationId in a send body", async () => {
    // The path decides which conversation is written; a body field must not
    // be able to redirect the message into a different thread.
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();

    const mine = await openConversation(a, b);
    const other = await openConversation(a, c);

    const response = await request(app)
      .post(`${BASE}/conversations/${mine}/messages`)
      .set(...bearer(a.token))
      .send({ content: "routed", conversationId: other })
      .expect(201);

    expect(response.body.data.message.conversationId).toBe(mine);
  });

  it("ignores supplied timestamps and read state", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const response = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({
        content: "backdated",
        createdAt: "1999-01-01T00:00:00.000Z",
        editedAt: "1999-01-01T00:00:00.000Z",
        seenByUserIds: [a.userId, b.userId],
      })
      .expect(201);

    const message = response.body.data.message;
    expect(new Date(message.createdAt as string).getFullYear()).toBeGreaterThan(2020);
    expect(message.editedAt).toBeNull();
    // Only the sender has seen it; the claim that b had was discarded.
    expect(message.seenByUserIds).toEqual([a.userId]);
  });
});

/* ── Blocking ────────────────────────────────────────────────────────────── */

describe("blocking", () => {
  it("refuses to open a conversation with someone who blocked you", async () => {
    const a = await createUser();
    const b = await createUser();
    await block(b, a);

    const response = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(404);

    // Identical to a missing user: the refusal must not announce the block.
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses to open a conversation with someone you blocked", async () => {
    const a = await createUser();
    const b = await createUser();
    await block(a, b);

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(404);
  });

  it("closes an existing conversation to the blocked party", async () => {
    // The rule the brief states outright: membership does not override a block.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "before the block");

    await block(b, a);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set(...bearer(a.token))
      .expect(404);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .expect(404);
  });

  it("closes it to the blocker too", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await block(b, a);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set(...bearer(b.token))
      .expect(404);
  });

  it("refuses a send into a blocked conversation", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await block(b, a);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "still there?" })
      .expect(404);
  });

  it("refuses reactions, edits, and deletes once blocked", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "mine");

    await block(b, a);

    await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(a.token))
      .send({ emoji: "👍" })
      .expect(404);

    await request(app)
      .patch(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .send({ content: "edited after block" })
      .expect(404);

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .expect(404);
  });

  it("refuses marking read and unread counts once blocked", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await block(b, a);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(a.token))
      .send({})
      .expect(404);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(a.token))
      .expect(404);
  });

  it("refuses search once blocked", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "secret plan");
    await block(b, a);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages/search`)
      .query({ q: "secret" })
      .set(...bearer(a.token))
      .expect(404);
  });
});

/* ── whoCanMessage ───────────────────────────────────────────────────────── */

describe("whoCanMessage enforcement", () => {
  it("allows anyone under the default `everyone`", async () => {
    const a = await createUser();
    const b = await createUser();

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(201);
  });

  it("refuses a non-follower under `followers`", async () => {
    const a = await createUser();
    const b = await createUser();
    await setPolicy(b, "followers");

    const response = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(404);

    // Indistinguishable from an unknown user, so the setting is not an oracle.
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("allows a follower under `followers`", async () => {
    const a = await createUser();
    const b = await createUser();
    await setPolicy(b, "followers");
    await follow(a, b);

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(201);
  });

  it("reads the direction as sender-follows-recipient", async () => {
    // b following a is NOT enough: "who can message you -> followers" means
    // b's own followers, so a must follow b.
    const a = await createUser();
    const b = await createUser();
    await setPolicy(b, "followers");
    await follow(b, a);

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(404);
  });

  it("closes an open thread to new sends when the policy tightens", async () => {
    // Enforced on every send, not only at creation — otherwise the policy is
    // defeated by opening a conversation first and messaging later.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "while permitted");

    await setPolicy(b, "followers");

    const response = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "after the change" })
      .expect(403);

    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");
  });

  it("leaves history readable when the policy tightens", async () => {
    // Only the write closes. Retroactively hiding a conversation someone has
    // already read would be a surprising and destructive reading of a contact
    // preference.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "still readable");

    await setPolicy(b, "followers");

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .expect(200);

    expect(response.body.data.items[0].content).toBe("still readable");
  });

  it("never restricts the person who set the policy from replying", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await setPolicy(b, "followers");

    // b's own setting is about who may message *b*; it must not stop b.
    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(b.token))
      .send({ content: "I can still reply" })
      .expect(201);
  });

  it("puts a block ahead of a satisfied policy", async () => {
    const a = await createUser();
    const b = await createUser();
    await setPolicy(b, "followers");
    await follow(a, b);
    await block(b, a);

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(404);
  });
});

/* ── Cross-conversation access ───────────────────────────────────────────── */

describe("a stranger cannot reach another conversation", () => {
  it("cannot read it", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "private");

    for (const path of [
      `${BASE}/conversations/${conversationId}`,
      `${BASE}/conversations/${conversationId}/messages`,
      `${BASE}/conversations/${conversationId}/unread`,
    ]) {
      await request(app)
        .get(path)
        .set(...bearer(outsider.token))
        .expect(404);
    }
  });

  it("cannot write into it", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(outsider.token))
      .send({ content: "intruding" })
      .expect(404);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(outsider.token))
      .send({})
      .expect(404);
  });

  it("cannot touch its messages", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "not yours");

    await request(app)
      .patch(`${BASE}/${messageId}`)
      .set(...bearer(outsider.token))
      .send({ content: "rewritten" })
      .expect(404);

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(outsider.token))
      .expect(404);

    await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(outsider.token))
      .send({ emoji: "👀" })
      .expect(404);
  });

  it("cannot see it in their own conversation list", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await createUser();
    const conversationId = await openConversation(a, b);

    const response = await request(app)
      .get(`${BASE}/conversations`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect(response.body.data.items.map((item: { id: string }) => item.id)).not.toContain(
      conversationId,
    );
  });
});

/* ── Platform admin has no special messaging power ───────────────────────── */

describe("admin role", () => {
  it("does not let an admin read someone else's conversation", async () => {
    // Phases 4-7 kept platform admin out of ordinary social surfaces. Private
    // correspondence is the last place it should arrive by accident.
    const a = await createUser();
    const b = await createUser();
    const admin = await createUser();

    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: "platform_admin" },
    });

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({
        email: (
          await prisma.user.findUniqueOrThrow({
            where: { id: admin.userId },
            select: { email: true },
          })
        ).email,
        password: PASSWORD,
        rememberMe: false,
      })
      .expect(200);

    const adminToken = login.body.data.accessToken as string;
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "confidential");

    await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set(...bearer(adminToken))
      .expect(404);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(adminToken))
      .expect(404);
  });

  it("does not let an admin bypass `followers`", async () => {
    const target = await createUser();
    const admin = await createUser();

    await prisma.user.update({
      where: { id: admin.userId },
      data: { role: "platform_admin" },
    });
    await setPolicy(target, "followers");

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({
        email: (
          await prisma.user.findUniqueOrThrow({
            where: { id: admin.userId },
            select: { email: true },
          })
        ).email,
        password: PASSWORD,
        rememberMe: false,
      })
      .expect(200);

    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(login.body.data.accessToken as string))
      .send({ username: target.username })
      .expect(404);
  });
});

/* ── Authentication is required everywhere ───────────────────────────────── */

describe("no anonymous access", () => {
  it("401s every messaging route", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "private");

    const cases: [string, string][] = [
      ["get", `${BASE}/conversations`],
      ["post", `${BASE}/conversations`],
      ["get", `${BASE}/conversations/${conversationId}`],
      ["get", `${BASE}/conversations/${conversationId}/messages`],
      ["post", `${BASE}/conversations/${conversationId}/messages`],
      ["get", `${BASE}/conversations/${conversationId}/messages/search`],
      ["post", `${BASE}/conversations/${conversationId}/read`],
      ["get", `${BASE}/conversations/${conversationId}/unread`],
      ["patch", `${BASE}/${messageId}`],
      ["delete", `${BASE}/${messageId}`],
      ["post", `${BASE}/${messageId}/reactions`],
      ["delete", `${BASE}/${messageId}/reactions/${encodeURIComponent("👍")}`],
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
});
