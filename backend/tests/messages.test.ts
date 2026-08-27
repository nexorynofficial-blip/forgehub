import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Messaging over HTTP (BACKEND_ARCHITECTURE.md §13, TRD §20–21).
 *
 * The authorization matrix has its own exhaustive unit suite; this file proves
 * the matrix is actually *wired* to the endpoints. A correct rule table
 * connected to the wrong service call is still a privilege-escalation bug, and
 * only a request can show the two are joined up.
 *
 * The non-disclosure convention is asserted everywhere it applies: a
 * conversation the caller does not belong to must answer 404, never 403, and
 * a refused conversation request must be indistinguishable from a missing user.
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

const NS = "msgapi";
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

async function createUser(displayName = "Message Tester"): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName,
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

/** Opens (or reuses) a direct conversation and returns its id. */
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

let alice: TestUser;
let bob: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  await connectRedis();
  [alice, bob, stranger] = await Promise.all([
    createUser("Alice"),
    createUser("Bob"),
    createUser("Stranger"),
  ]);
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

/* ── Conversations ───────────────────────────────────────────────────────── */

describe("POST /messages/conversations", () => {
  it("creates a direct conversation with 201", async () => {
    const a = await createUser();
    const b = await createUser();

    const response = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(201);

    const conversation = response.body.data.conversation;
    expect(conversation.isGroup).toBe(false);
    expect(new Set(conversation.participantIds)).toEqual(new Set([a.userId, b.userId]));
    // The viewer is excluded from `participants` but kept in `participantIds`,
    // matching the frontend's `ConversationWithParticipants`.
    expect(conversation.participants).toHaveLength(1);
    expect(conversation.participants[0].username).toBe(b.username);
  });

  it("returns 200 and the same conversation on a repeat request", async () => {
    const a = await createUser();
    const b = await createUser();

    const first = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(201);

    const second = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({ username: b.username })
      .expect(200);

    expect(second.body.data.conversation.id).toBe(first.body.data.conversation.id);
  });

  it("returns the same conversation when the other party initiates", async () => {
    const a = await createUser();
    const b = await createUser();

    const forward = await openConversation(a, b);
    const reverse = await openConversation(b, a);

    expect(reverse).toBe(forward);
  });

  it("404s an unknown username", async () => {
    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(alice.token))
      .send({ username: "nobody-at-all" })
      .expect(404);
  });

  it("refuses a conversation with yourself", async () => {
    await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(alice.token))
      .send({ username: alice.username })
      .expect(422);
  });

  it("requires authentication", async () => {
    await request(app)
      .post(`${BASE}/conversations`)
      .send({ username: bob.username })
      .expect(401);
  });

  it("ignores a client-supplied participant list", async () => {
    // `participantIds` is in no schema, so Zod strips it. The conversation is
    // between the token holder and the named user, and nobody else.
    const a = await createUser();
    const b = await createUser();

    const response = await request(app)
      .post(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .send({
        username: b.username,
        participantIds: [stranger.userId, alice.userId],
        isGroup: true,
      })
      .expect(201);

    expect(new Set(response.body.data.conversation.participantIds)).toEqual(
      new Set([a.userId, b.userId]),
    );
    expect(response.body.data.conversation.isGroup).toBe(false);
  });
});

describe("GET /messages/conversations", () => {
  it("lists only the caller's conversations", async () => {
    const a = await createUser();
    const b = await createUser();
    await openConversation(a, b);

    const response = await request(app)
      .get(`${BASE}/conversations`)
      .set(...bearer(a.token))
      .expect(200);

    const ids: string[] = response.body.data.items.map((item: { id: string }) => item.id);
    expect(ids).toHaveLength(1);

    const outsider = await request(app)
      .get(`${BASE}/conversations`)
      .set(...bearer(stranger.token))
      .expect(200);

    expect(outsider.body.data.items.map((i: { id: string }) => i.id)).not.toContain(
      ids[0],
    );
  });

  it("carries the last message and an unread count", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    await sendMessage(a, conversationId, "hello there");

    const response = await request(app)
      .get(`${BASE}/conversations`)
      .set(...bearer(b.token))
      .expect(200);

    const conversation = response.body.data.items.find(
      (item: { id: string }) => item.id === conversationId,
    );

    expect(conversation.lastMessage.content).toBe("hello there");
    expect(conversation.lastMessage.sender.username).toBe(a.username);
    expect(conversation.unreadCount).toBe(1);
  });

  it("paginates with a cursor", async () => {
    const owner = await createUser();
    for (let index = 0; index < 3; index += 1) {
      const partner = await createUser();
      const id = await openConversation(owner, partner);
      await sendMessage(owner, id, `msg ${String(index)}`);
    }

    const first = await request(app)
      .get(`${BASE}/conversations`)
      .query({ limit: 2 })
      .set(...bearer(owner.token))
      .expect(200);

    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`${BASE}/conversations`)
      .query({ limit: 2, cursor: first.body.data.nextCursor })
      .set(...bearer(owner.token))
      .expect(200);

    const firstIds = first.body.data.items.map((i: { id: string }) => i.id);
    const secondIds = second.body.data.items.map((i: { id: string }) => i.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });
});

describe("GET /messages/conversations/:id", () => {
  it("returns a conversation to its member", async () => {
    const conversationId = await openConversation(alice, bob);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set(...bearer(bob.token))
      .expect(200);

    expect(response.body.data.conversation.id).toBe(conversationId);
  });

  it("404s — not 403 — for a non-member", async () => {
    // The canonical non-disclosure response. A 403 would confirm the
    // conversation exists and that these two people are talking.
    const conversationId = await openConversation(alice, bob);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}`)
      .set(...bearer(stranger.token))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("404s a conversation that does not exist, identically", async () => {
    const response = await request(app)
      .get(`${BASE}/conversations/00000000-0000-4000-8000-000000000000`)
      .set(...bearer(stranger.token))
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("422s a malformed id rather than reaching the database", async () => {
    await request(app)
      .get(`${BASE}/conversations/not-a-uuid`)
      .set(...bearer(alice.token))
      .expect(422);
  });
});

/* ── Messages ────────────────────────────────────────────────────────────── */

describe("messages", () => {
  it("sends and lists a message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    await sendMessage(a, conversationId, "first");
    await sendMessage(b, conversationId, "second");

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .expect(200);

    // Newest first, as the index and a chat UI both want.
    expect(
      response.body.data.items.map((item: { content: string }) => item.content),
    ).toEqual(["second", "first"]);
  });

  it("stamps the sender from the token, ignoring a supplied senderId", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const response = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "who sent this?", senderId: b.userId, authorId: b.userId })
      .expect(201);

    expect(response.body.data.message.senderId).toBe(a.userId);
  });

  it("accepts attachment URLs and metadata", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const response = await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({
        content: "have a look",
        attachments: [
          { url: "media-ref-1", name: "shot.png", type: "image", sizeBytes: 2048 },
        ],
      })
      .expect(201);

    const attachment = response.body.data.message.attachments[0];
    expect(attachment.url).toBe("media-ref-1");
    expect(attachment.type).toBe("image");
    expect(attachment.sizeBytes).toBe(2048);
  });

  it("allows an attachment-only message but not an empty one", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ attachments: [{ url: "ref", name: "file.pdf", type: "file" }] })
      .expect(201);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .send({ content: "   " })
      .expect(422);
  });

  it("404s a send into a conversation the caller does not belong to", async () => {
    const conversationId = await openConversation(alice, bob);

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(stranger.token))
      .send({ content: "let me in" })
      .expect(404);
  });

  it("pages message history with a cursor", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    for (let index = 0; index < 5; index += 1) {
      await sendMessage(a, conversationId, `m${String(index)}`);
    }

    const first = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .query({ limit: 2 })
      .set(...bearer(a.token))
      .expect(200);

    expect(first.body.data.items.map((i: { content: string }) => i.content)).toEqual([
      "m4",
      "m3",
    ]);

    const second = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .query({ limit: 2, cursor: first.body.data.nextCursor })
      .set(...bearer(a.token))
      .expect(200);

    expect(second.body.data.items.map((i: { content: string }) => i.content)).toEqual([
      "m2",
      "m1",
    ]);
  });
});

describe("editing and deleting", () => {
  it("lets an author edit their own message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "typo heer");

    const response = await request(app)
      .patch(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .send({ content: "typo here" })
      .expect(200);

    expect(response.body.data.message.content).toBe("typo here");
    expect(response.body.data.message.editedAt).not.toBeNull();
  });

  it("403s an edit of someone else's message", async () => {
    // 403 rather than 404 here on purpose: the caller is a member of this
    // conversation and has already read the message, so its existence is not
    // a secret — only the authority to rewrite it is missing.
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "mine");

    const response = await request(app)
      .patch(`${BASE}/${messageId}`)
      .set(...bearer(b.token))
      .send({ content: "hijacked" })
      .expect(403);

    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");

    const check = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .expect(200);
    expect(check.body.data.items[0].content).toBe("mine");
  });

  it("404s an edit from someone outside the conversation entirely", async () => {
    const conversationId = await openConversation(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "private");

    await request(app)
      .patch(`${BASE}/${messageId}`)
      .set(...bearer(stranger.token))
      .send({ content: "intercepted" })
      .expect(404);
  });

  it("soft-deletes an author's own message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "regret");

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .expect(200);

    const listed = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(b.token))
      .expect(200);
    expect(listed.body.data.items).toHaveLength(0);

    // The historical record survives; only the read paths skip it.
    const row = await prisma.message.findUnique({
      where: { id: messageId },
      select: { content: true, deletedAt: true },
    });
    expect(row?.content).toBe("regret");
    expect(row?.deletedAt).not.toBeNull();
  });

  it("403s deleting the other participant's message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "not yours to remove");

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(b.token))
      .expect(403);
  });

  it("404s a second delete of the same message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "gone");

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .expect(200);

    await request(app)
      .delete(`${BASE}/${messageId}`)
      .set(...bearer(a.token))
      .expect(404);
  });
});

/* ── Reactions ───────────────────────────────────────────────────────────── */

describe("reactions", () => {
  it("adds and removes a reaction", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "react please");

    const added = await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(b.token))
      .send({ emoji: "👍" })
      .expect(201);

    const reaction = added.body.data.message.reactions[0];
    expect(reaction.emoji).toBe("👍");
    expect(reaction.count).toBe(1);
    expect(reaction.userIds).toEqual([b.userId]);
    // From b's perspective, since b is the caller.
    expect(reaction.reactedByViewer).toBe(true);

    const removed = await request(app)
      .delete(`${BASE}/${messageId}/reactions/${encodeURIComponent("👍")}`)
      .set(...bearer(b.token))
      .expect(200);

    expect(removed.body.data.message.reactions).toHaveLength(0);
  });

  it("is idempotent on a repeated add", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "double");

    await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(b.token))
      .send({ emoji: "🔥" })
      .expect(201);

    const second = await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(b.token))
      .send({ emoji: "🔥" })
      .expect(201);

    expect(second.body.data.message.reactions).toHaveLength(1);
    expect(second.body.data.message.reactions[0].count).toBe(1);
  });

  it("groups the same emoji from several people", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    const messageId = await sendMessage(a, conversationId, "consensus?");

    await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(a.token))
      .send({ emoji: "👍" })
      .expect(201);

    const response = await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(b.token))
      .send({ emoji: "👍" })
      .expect(201);

    const reaction = response.body.data.message.reactions[0];
    expect(reaction.count).toBe(2);
    expect(new Set(reaction.userIds)).toEqual(new Set([a.userId, b.userId]));
  });

  it("404s a reaction to a message in an inaccessible conversation", async () => {
    const conversationId = await openConversation(alice, bob);
    const messageId = await sendMessage(alice, conversationId, "not for you");

    await request(app)
      .post(`${BASE}/${messageId}/reactions`)
      .set(...bearer(stranger.token))
      .send({ emoji: "👀" })
      .expect(404);
  });
});

/* ── Read receipts and unread counts ─────────────────────────────────────── */

describe("read receipts", () => {
  it("marks a conversation read and clears the unread count", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    await sendMessage(a, conversationId, "one");
    await sendMessage(a, conversationId, "two");

    const before = await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(b.token))
      .expect(200);
    expect(before.body.data.unreadCount).toBe(2);

    const receipt = await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(b.token))
      .send({})
      .expect(200);

    expect(receipt.body.data.unreadCount).toBe(0);
    expect(receipt.body.data.lastReadAt).not.toBeNull();

    const after = await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(b.token))
      .expect(200);
    expect(after.body.data.unreadCount).toBe(0);
  });

  it("reports seenByUserIds once the other side has read", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "did you see this?");

    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(b.token))
      .send({})
      .expect(200);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages`)
      .set(...bearer(a.token))
      .expect(200);

    expect(new Set(response.body.data.items[0].seenByUserIds)).toEqual(
      new Set([a.userId, b.userId]),
    );
  });

  it("marks read only for the caller, never for the other party", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);
    await sendMessage(a, conversationId, "unread for b");

    // `a` marking read must not clear `b`'s unread count. There is no
    // parameter for whose watermark moves.
    await request(app)
      .post(`${BASE}/conversations/${conversationId}/read`)
      .set(...bearer(a.token))
      .send({ userId: b.userId })
      .expect(200);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(b.token))
      .expect(200);

    expect(response.body.data.unreadCount).toBe(1);
  });

  it("404s marking read with a message id from another conversation", async () => {
    const a = await createUser();
    const b = await createUser();
    const mine = await openConversation(a, b);
    const other = await openConversation(alice, bob);

    const foreign = await sendMessage(alice, other, "elsewhere");

    await request(app)
      .post(`${BASE}/conversations/${mine}/read`)
      .set(...bearer(a.token))
      .send({ messageId: foreign })
      .expect(404);
  });

  it("404s an unread count for a conversation the caller is not in", async () => {
    const conversationId = await openConversation(alice, bob);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/unread`)
      .set(...bearer(stranger.token))
      .expect(404);
  });
});

/* ── Search ──────────────────────────────────────────────────────────────── */

describe("search within a conversation", () => {
  it("finds a matching message", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    await sendMessage(a, conversationId, "Deploying on Friday");
    await sendMessage(b, conversationId, "sounds good");

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages/search`)
      .query({ q: "friday" })
      .set(...bearer(a.token))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].content).toBe("Deploying on Friday");
  });

  it("404s a search of someone else's conversation", async () => {
    const conversationId = await openConversation(alice, bob);
    await sendMessage(alice, conversationId, "confidential");

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages/search`)
      .query({ q: "confidential" })
      .set(...bearer(stranger.token))
      .expect(404);
  });

  it("requires a search term", async () => {
    const conversationId = await openConversation(alice, bob);

    await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages/search`)
      .set(...bearer(alice.token))
      .expect(422);
  });

  it("excludes deleted messages from results", async () => {
    const a = await createUser();
    const b = await createUser();
    const conversationId = await openConversation(a, b);

    const gone = await sendMessage(a, conversationId, "needle removed");
    await sendMessage(a, conversationId, "needle kept");

    await request(app)
      .delete(`${BASE}/${gone}`)
      .set(...bearer(a.token))
      .expect(200);

    const response = await request(app)
      .get(`${BASE}/conversations/${conversationId}/messages/search`)
      .query({ q: "needle" })
      .set(...bearer(a.token))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].content).toBe("needle kept");
  });
});
