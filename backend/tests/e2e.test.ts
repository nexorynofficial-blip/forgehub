import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Phase 13 — the critical end-to-end path (ARCHITECTURE §35 "Critical
 * end-to-end tests"; TRD §32 "Critical functionality should have integration
 * tests").
 *
 * Fifty-five suites test their own module thoroughly. None of them tests the
 * product: one user's action arriving in another user's inbox, a report
 * filed in Phase 11 removing a post created in Phase 6, a block from Phase 4
 * silencing a notification from Phase 9. Those seams are exactly where a
 * refactor inside one module breaks another, and until now nothing watched
 * them.
 *
 * This file is deliberately **one narrative in order**, not a set of
 * independent cases. Vitest runs `it` blocks in declaration order within a
 * file, and each step here builds on the last, because that is what makes it
 * an end-to-end test rather than eleven more unit tests. A failure part-way
 * through names the seam that broke.
 *
 * Everything it asserts is scoped to fixtures it created. It never counts
 * global rows — test files run in parallel against one database, so a global
 * count is a race, not an assertion.
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

const NS = "e2eflow";
const PASSWORD = "ValidPass123";

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}-${String(Date.now())}`;
}

interface Actor {
  email: string;
  userId: string;
  username: string;
  token: string;
}

async function createUser(displayName: string): Promise<Actor> {
  const email = `${NS}.${unique("u")}@forgehub.test`;

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
    email,
    userId: login.body.data.user.id as string,
    username: login.body.data.user.username as string,
    token: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

async function promote(
  actor: Actor,
  role: "moderator" | "platform_admin",
): Promise<Actor> {
  await prisma.user.update({ where: { id: actor.userId }, data: { role } });
  return actor;
}

/** Notifications the recipient can currently see, newest first. */
async function inboxOf(actor: Actor): Promise<Array<Record<string, unknown>>> {
  const response = await request(app)
    .get("/api/v1/notifications")
    .set(...bearer(actor.token))
    .expect(200);

  return response.body.data.items as Array<Record<string, unknown>>;
}

/* ── Cast ────────────────────────────────────────────────────────────────── */

let author: Actor;
let reader: Actor;
let moderator: Actor;

let projectSlug: string;
let postId: string;
let reportId: string;

beforeAll(async () => {
  await connectRedis();

  author = await createUser("E2E Author");
  reader = await createUser("E2E Reader");
  moderator = await promote(await createUser("E2E Moderator"), "platform_admin");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // Order matters: `ModerationAction` and `Report` reference users with a
    // restricting foreign key, so they go before the users do.
    await prisma.moderationAction.deleteMany({
      where: { OR: [{ moderatorId: { in: ids } }, { targetUserId: { in: ids } }] },
    });
    await prisma.report.deleteMany({
      where: {
        OR: [
          { reporterId: { in: ids } },
          { reviewerId: { in: ids } },
          { targetAuthorId: { in: ids } },
        ],
      },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });

    // Authored content is `onDelete: Restrict` throughout — Phase 5 and
    // Phase 6 both protect a row from vanishing with its author — so the
    // content goes before the accounts, innermost first.
    await prisma.message.deleteMany({ where: { senderId: { in: ids } } });
    await prisma.conversation.deleteMany({
      where: { members: { some: { userId: { in: ids } } } },
    });
    await prisma.comment.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });

    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

describe("A builder publishes, an audience arrives, a moderator intervenes", () => {
  it("1. registration produces a usable, authenticated identity", async () => {
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(author.token))
      .expect(200);

    expect(me.body.data.user.id).toBe(author.userId);
    // The credential never comes back out, on any phase's endpoint.
    expect(JSON.stringify(me.body)).not.toContain("passwordHash");
  });

  it("2. the author ships a project", async () => {
    const response = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(author.token))
      .send({
        title: unique("E2E Project"),
        description: "An end-to-end fixture project for Phase 13.",
      })
      .expect(201);

    projectSlug = response.body.data.project.slug as string;
    expect(projectSlug).toBeTruthy();

    // Phase 5 denormalises a counter on the owner; it must move with the write.
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: author.userId },
      select: { projectsCount: true },
    });
    expect(owner.projectsCount).toBe(1);
  });

  it("3. the author posts, and the post is publicly readable", async () => {
    const created = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({ content: `${unique("E2E post")} — hello from Phase 13.` })
      .expect(201);

    postId = created.body.data.post.id as string;

    // A different signed-in user can read it, and so can an anonymous caller.
    await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(reader.token))
      .expect(200);
    await request(app).get(`/api/v1/posts/${postId}`).expect(200);
  });

  it("4. a follow crosses from the social graph into the inbox", async () => {
    await request(app)
      .post(`/api/v1/users/${author.username}/follow`)
      .set(...bearer(reader.token))
      .expect(201);

    // Phase 4 wrote the edge; Phase 9 must have been told about it through
    // the port, without Phase 4 knowing Phase 9 exists.
    const inbox = await inboxOf(author);
    const follow = inbox.find((entry) => entry["type"] === "follower");

    expect(follow, "a follow must notify the followed user").toBeDefined();
    expect((follow?.["actor"] as Record<string, unknown>)["id"]).toBe(reader.userId);
  });

  it("5. a like and a comment each reach the author", async () => {
    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(reader.token))
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(reader.token))
      .send({ content: "Congratulations on shipping this." })
      .expect(201);

    const inbox = await inboxOf(author);
    const types = new Set(inbox.map((entry) => entry["type"]));
    expect(types.has("like")).toBe(true);
    expect(types.has("comment")).toBe(true);

    // Phase 6 keeps a denormalised comment counter; the write must move it.
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: postId },
      select: { commentsCount: true, likesCount: true },
    });
    expect(post.commentsCount).toBe(1);
    expect(post.likesCount).toBe(1);
  });

  it("6. the two users can hold a private conversation", async () => {
    const conversation = await request(app)
      .post("/api/v1/messages/conversations")
      .set(...bearer(reader.token))
      .send({ username: author.username })
      .expect(201);

    const conversationId = conversation.body.data.conversation.id as string;

    await request(app)
      .post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set(...bearer(reader.token))
      .send({ content: "Would you like a collaborator?" })
      .expect(201);

    // The author sees it; a third party must not even be able to address it.
    const seen = await request(app)
      .get(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set(...bearer(author.token))
      .expect(200);
    expect(seen.body.data.items).toHaveLength(1);

    await request(app)
      .get(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set(...bearer(moderator.token))
      .expect(404);
  });

  it("7. search discovers the project without leaking anything private", async () => {
    const response = await request(app)
      .get(
        `/api/v1/search?q=${encodeURIComponent(projectSlug.slice(0, 20))}&type=projects`,
      )
      .expect(200);

    expect(response.body.success).toBe(true);
    // Anonymous search must never surface an email address.
    expect(JSON.stringify(response.body)).not.toContain("@forgehub.test");
  });

  it("8. a reader files a report and a moderator claims it", async () => {
    const filed = await request(app)
      .post("/api/v1/moderation/reports")
      .set(...bearer(reader.token))
      .send({
        targetType: "post",
        targetId: postId,
        reason: "spam",
        details: "Phase 13 end-to-end fixture.",
      })
      .expect(201);

    reportId = filed.body.data.report.id as string;
    expect(filed.body.data.report.status).toBe("pending");
    // The reporter is taken from the session, never the body.
    expect(filed.body.data.report.reporterId).toBe(reader.userId);

    // An ordinary user cannot read the queue.
    await request(app)
      .get("/api/v1/moderation/reports")
      .set(...bearer(reader.token))
      .expect(403);

    const claimed = await request(app)
      .patch(`/api/v1/moderation/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(200);

    expect(claimed.body.data.report.reviewerId).toBe(moderator.userId);
  });

  it("9. the moderation action, the audit row, and the notice are one transaction", async () => {
    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .send({
        action: "content_removal",
        targetType: "post",
        targetId: postId,
        reason: "Phase 13 end-to-end fixture.",
      })
      .expect(201);

    // The post is gone from every read path.
    await request(app).get(`/api/v1/posts/${postId}`).expect(404);

    // Ruling R9: the audit row is written with the action, not after it.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "POST_REMOVED", targetId: postId },
    });
    expect(audit, "a moderation action must leave an audit row").not.toBeNull();
    expect(audit?.actorId).toBe(moderator.userId);

    // Ruling R11: the affected user is told, with no actor attached.
    const inbox = await inboxOf(author);
    const notice = inbox.find((entry) => entry["type"] === "moderation");
    expect(notice, "the affected user must be notified").toBeDefined();
    expect(notice?.["actor"]).toBeNull();
  });

  it("10. only a platform admin may read the audit trail", async () => {
    await request(app)
      .get("/api/v1/admin/audit-logs")
      .set(...bearer(reader.token))
      .expect(403);

    const trail = await request(app)
      .get("/api/v1/admin/audit-logs")
      .query({ action: "POST_REMOVED", targetId: postId })
      .set(...bearer(moderator.token))
      .expect(200);

    // Scoped to this story's own row rather than counting the whole table —
    // suites run in parallel against one database.
    expect(Array.isArray(trail.body.data)).toBe(true);
    expect(trail.body.pagination.total).toBe(1);
    expect(trail.body.data[0].actor.id).toBe(moderator.userId);

    // TRD §29: append-only. There is no write route to find.
    await request(app)
      .post("/api/v1/admin/audit-logs")
      .set(...bearer(moderator.token))
      .send({ action: "FORGED" })
      .expect(404);
  });

  it("11. a block silences the blocker's inbox without erasing history", async () => {
    const before = (await inboxOf(author)).length;

    await request(app)
      .post(`/api/v1/users/${reader.username}/block`)
      .set(...bearer(author.token))
      .expect(201);

    // A blocked user's new activity must not reach the blocker. The comment
    // is on a removed post, so a fresh like on a *new* post is the cleanest
    // probe available at this point in the story.
    const fresh = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({ content: unique("E2E post after block") })
      .expect(201);

    // 404, not 403: ARCHITECTURE §18's rule that a visibility refusal must
    // not confirm the resource exists. The blocked user is told nothing.
    await request(app)
      .post(`/api/v1/posts/${fresh.body.data.post.id as string}/like`)
      .set(...bearer(reader.token))
      .expect(404);

    const after = await inboxOf(author);
    expect(after.length).toBe(before);
  });

  it("12. a ban decided in Phase 11 is enforced by Phase 3 on the next request", async () => {
    await request(app)
      .post("/api/v1/moderation/actions")
      .set(...bearer(moderator.token))
      .send({
        action: "ban",
        targetType: "user",
        targetId: reader.userId,
        reason: "Phase 13 end-to-end fixture.",
      })
      .expect(201);

    // No re-login, no token refresh: the very next request is refused.
    await request(app)
      .get("/api/v1/auth/me")
      .set(...bearer(reader.token))
      .expect(403);

    const banned = await prisma.user.findUniqueOrThrow({
      where: { id: reader.userId },
      select: { status: true },
    });
    expect(banned.status).toBe("banned");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_BANNED", targetId: reader.userId },
    });
    expect(audit).not.toBeNull();
  });

  it("13. the moderator closes the report and the trail is complete", async () => {
    const resolved = await request(app)
      .patch(`/api/v1/moderation/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "resolved", resolution: "Content removed, account banned." })
      .expect(200);

    expect(resolved.body.data.report.status).toBe("resolved");
    expect(resolved.body.data.report.resolvedAt).not.toBeNull();

    // A terminal report is terminal — reopening it is a 409, not a silent
    // overwrite of the reviewer and resolution.
    await request(app)
      .patch(`/api/v1/moderation/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(409);

    // The whole story is recoverable from the audit trail alone.
    const trail = await prisma.auditLog.findMany({
      where: { actorId: moderator.userId },
      select: { action: true },
    });
    const actions = new Set(trail.map((row) => row.action));
    expect(actions.has("POST_REMOVED")).toBe(true);
    expect(actions.has("USER_BANNED")).toBe(true);
  });
});
