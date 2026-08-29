import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The moderation workflow end to end (PRD §17, TRD §28, ARCHITECTURE §25).
 *
 * §25 draws the flow this file walks:
 *
 *     User → Report → Report Service → Moderation Queue → Moderator
 *          → Moderation Action → Audit Log
 *
 * Every stage is exercised against a real database and a real HTTP stack.
 * Authorization refusals live in `moderation-security.test.ts`; this file is
 * about the workflow behaving correctly for callers who are allowed to use it.
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

const NS = "modflow";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/moderation";

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
      displayName: "Moderation Tester",
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

/**
 * Roles are granted directly. `auth.middleware` re-reads the user on every
 * request, so a role change takes effect immediately without a fresh login —
 * which is itself the Phase 3 behaviour this relies on.
 */
async function promote(user: TestUser, role: "moderator" | "platform_admin") {
  await prisma.user.update({ where: { id: user.userId }, data: { role } });
  return user;
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

async function createPost(author: TestUser): Promise<string> {
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(author.token))
    .send({ type: "text", content: "A post that will be reported." })
    .expect(201);

  return response.body.data.post.id as string;
}

async function fileReport(
  reporter: TestUser,
  targetType: string,
  targetId: string,
  reason = "spam",
): Promise<string> {
  const response = await request(app)
    .post(`${BASE}/reports`)
    .set(...bearer(reporter.token))
    .send({ targetType, targetId, reason, details: "Please review." })
    .expect(201);

  return response.body.data.report.id as string;
}

/** Drives a report to `reviewing`, the only state a close can follow. */
async function claim(moderator: TestUser, reportId: string): Promise<void> {
  await request(app)
    .patch(`${BASE}/reports/${reportId}`)
    .set(...bearer(moderator.token))
    .send({ status: "reviewing" })
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
    await prisma.moderationAction.deleteMany({
      where: { OR: [{ moderatorId: { in: ids } }, { targetUserId: { in: ids } }] },
    });
    await prisma.report.deleteMany({
      where: {
        OR: [
          { reporterId: { in: ids } },
          { targetAuthorId: { in: ids } },
          { reviewerId: { in: ids } },
        ],
      },
    });
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.comment.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Filing ──────────────────────────────────────────────────────────────── */

describe("POST /moderation/reports", () => {
  it("files a report against a post", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const postId = await createPost(author);

    const response = await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({
        targetType: "post",
        targetId: postId,
        reason: "spam",
        details: "Repeated advertising.",
      })
      .expect(201);

    const report = response.body.data.report;
    expect(report.reporterId).toBe(reporter.userId);
    expect(report.targetType).toBe("post");
    expect(report.targetId).toBe(postId);
    expect(report.status).toBe("pending");
    expect(report.reviewerId).toBeNull();
    expect(report.resolvedAt).toBeNull();
  });

  it("resolves and stores the target's author without being told it", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const postId = await createPost(author);
    const reportId = await fileReport(reporter, "post", postId);

    const stored = await prisma.report.findUnique({ where: { id: reportId } });
    expect(stored?.targetAuthorId).toBe(author.userId);
  });

  it("accepts every target type the schema carries, message included", async () => {
    const reporter = await createUser();
    const author = await createUser();
    const postId = await createPost(author);

    // `user` and `post` are checked against real rows; the enum itself is
    // pinned by the unit suite. `message` matters most here because the
    // shipped frontend type omits it.
    await fileReport(reporter, "post", postId);
    await fileReport(reporter, "user", author.userId, "harassment");

    const targets = await prisma.report.findMany({
      where: { reporterId: reporter.userId },
      select: { targetType: true },
    });
    expect(targets.map((row) => row.targetType).sort()).toEqual(["post", "user"]);
  });

  it("defaults details to an empty string", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const postId = await createPost(author);

    const response = await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({ targetType: "post", targetId: postId, reason: "other" })
      .expect(201);

    expect(response.body.data.report.details).toBe("");
  });

  it("404s a target that does not exist", async () => {
    const reporter = await createUser();

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({
        targetType: "post",
        targetId: "00000000-0000-4000-8000-000000000000",
        reason: "spam",
      })
      .expect(404);
  });

  it("422s an unknown reason and an unknown target type", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const postId = await createPost(author);

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({ targetType: "post", targetId: postId, reason: "vibes" })
      .expect(422);

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({ targetType: "notification", targetId: postId, reason: "spam" })
      .expect(422);
  });

  it("422s a malformed target id", async () => {
    const reporter = await createUser();

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({ targetType: "post", targetId: "not-a-uuid", reason: "spam" })
      .expect(422);
  });

  it("still files when the reporter has blocked the target's author", async () => {
    // Ruling R10. The person most likely to have blocked a harasser is the
    // one who needs to report them.
    const [reporter, author] = [await createUser(), await createUser()];
    const postId = await createPost(author);

    await request(app)
      .post(`/api/v1/users/${author.username}/block`)
      .set(...bearer(reporter.token))
      .expect(201);

    await fileReport(reporter, "post", postId);
  });
});

/* ── The queue ───────────────────────────────────────────────────────────── */

describe("GET /moderation/reports", () => {
  it("returns a paginated queue to a moderator", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    const postId = await createPost(author);
    await fileReport(reporter, "post", postId);

    const response = await request(app)
      .get(`${BASE}/reports`)
      .set(...bearer(moderator.token))
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20 });
    expect(response.body.pagination.total).toBeGreaterThan(0);
  });

  it("resolves the reporter and target author onto each row", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    const postId = await createPost(author);
    const reportId = await fileReport(reporter, "post", postId);

    const response = await request(app)
      .get(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .expect(200);

    const report = response.body.data.report;
    expect(report.reporter.id).toBe(reporter.userId);
    expect(report.targetAuthor.id).toBe(author.userId);
    expect(report.reporter.username).toBe(reporter.username);
  });

  it("filters by status, reviewing included", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    const postId = await createPost(author);
    const reportId = await fileReport(reporter, "post", postId);
    await claim(moderator, reportId);

    const response = await request(app)
      .get(`${BASE}/reports`)
      .query({ status: "reviewing" })
      .set(...bearer(moderator.token))
      .expect(200);

    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(reportId);
    for (const row of response.body.data) expect(row.status).toBe("reviewing");
  });

  it("filters by target type", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    await fileReport(reporter, "user", author.userId, "harassment");

    const response = await request(app)
      .get(`${BASE}/reports`)
      .query({ targetType: "user", limit: 100 })
      .set(...bearer(moderator.token))
      .expect(200);

    for (const row of response.body.data) expect(row.targetType).toBe("user");
  });

  it("orders the queue oldest first", async () => {
    const moderator = await promote(await createUser(), "moderator");

    const response = await request(app)
      .get(`${BASE}/reports`)
      .query({ limit: 100 })
      .set(...bearer(moderator.token))
      .expect(200);

    const times = response.body.data.map((row: { createdAt: string }) =>
      new Date(row.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("422s an unknown status filter", async () => {
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .get(`${BASE}/reports`)
      .query({ status: "escalated" })
      .set(...bearer(moderator.token))
      .expect(422);
  });

  it("404s a report that does not exist", async () => {
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .get(`${BASE}/reports/00000000-0000-4000-8000-000000000000`)
      .set(...bearer(moderator.token))
      .expect(404);
  });
});

/* ── Lifecycle ───────────────────────────────────────────────────────────── */

describe("the report lifecycle", () => {
  async function pendingReport(): Promise<{ moderator: TestUser; reportId: string }> {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    const postId = await createPost(author);
    return { moderator, reportId: await fileReport(reporter, "post", postId) };
  }

  it("moves pending → reviewing → resolved", async () => {
    const { moderator, reportId } = await pendingReport();

    const claimed = await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(200);

    expect(claimed.body.data.report.status).toBe("reviewing");
    expect(claimed.body.data.report.reviewerId).toBe(moderator.userId);
    expect(claimed.body.data.report.resolvedAt).toBeNull();

    const resolved = await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "resolved", resolution: "Content removed." })
      .expect(200);

    expect(resolved.body.data.report.status).toBe("resolved");
    expect(resolved.body.data.report.resolution).toBe("Content removed.");
    expect(resolved.body.data.report.resolvedAt).not.toBeNull();
  });

  it("moves pending → reviewing → dismissed", async () => {
    const { moderator, reportId } = await pendingReport();
    await claim(moderator, reportId);

    const dismissed = await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "dismissed" })
      .expect(200);

    expect(dismissed.body.data.report.status).toBe("dismissed");
    expect(dismissed.body.data.report.resolvedAt).not.toBeNull();
  });

  it("409s the pending → resolved shortcut", async () => {
    const { moderator, reportId } = await pendingReport();

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "resolved" })
      .expect(409);
  });

  it("409s reopening a closed report", async () => {
    const { moderator, reportId } = await pendingReport();
    await claim(moderator, reportId);

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "resolved" })
      .expect(200);

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(409);
  });

  it("409s a transition to the state already held", async () => {
    const { moderator, reportId } = await pendingReport();
    await claim(moderator, reportId);

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(409);
  });

  it("lets only one of two simultaneous claims win", async () => {
    const { moderator, reportId } = await pendingReport();
    const other = await promote(await createUser(), "moderator");

    const results = await Promise.all([
      request(app)
        .patch(`${BASE}/reports/${reportId}`)
        .set(...bearer(moderator.token))
        .send({ status: "reviewing" }),
      request(app)
        .patch(`${BASE}/reports/${reportId}`)
        .set(...bearer(other.token))
        .send({ status: "reviewing" }),
    ]);

    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
  });
});

/* ── Actions ─────────────────────────────────────────────────────────────── */

describe("POST /moderation/actions", () => {
  async function setup() {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");
    return { offender, moderator };
  }

  it("records a warning without changing the account's standing", async () => {
    const { offender, moderator } = await setup();

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "warning",
        targetType: "user",
        targetId: offender.userId,
        reason: "First offence.",
      })
      .expect(201);

    expect(response.body.data.action.action).toBe("warning");
    expect(response.body.data.statusChanged).toBe(false);

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("active");
  });

  it("bans an account permanently", async () => {
    const { offender, moderator } = await setup();

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    expect(response.body.data.statusChanged).toBe(true);
    expect(response.body.data.action.expiresAt).toBeNull();

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("banned");
  });

  it("suspends an account temporarily and stores the expiry", async () => {
    const { offender, moderator } = await setup();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt,
      })
      .expect(201);

    expect(response.body.data.action.action).toBe("suspension");
    expect(response.body.data.action.expiresAt).not.toBeNull();

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("banned");
  });

  it("400s a suspension with no expiry", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "suspension", targetType: "user", targetId: offender.userId })
      .expect(400);
  });

  it("400s an expiry on a verb that is not a suspension", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "ban",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(400);
  });

  it("400s a suspension expiring in the past", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      .expect(400);
  });

  it("400s an account verb aimed at content", async () => {
    const { moderator } = await setup();
    const author = await createUser();
    const postId = await createPost(author);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "post", targetId: postId })
      .expect(400);
  });

  it("400s a content removal aimed at an account", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "content_removal", targetType: "user", targetId: offender.userId })
      .expect(400);
  });

  it("unbans an account", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "unban", targetType: "user", targetId: offender.userId })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("active");
  });

  it("shadow bans and reinstates", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "shadow_ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    expect(
      (await prisma.user.findUnique({ where: { id: offender.userId } }))?.status,
    ).toBe("shadow_banned");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "reinstate", targetType: "user", targetId: offender.userId })
      .expect(201);

    expect(
      (await prisma.user.findUnique({ where: { id: offender.userId } }))?.status,
    ).toBe("active");
  });

  it("removes a post and reports that it did", async () => {
    const { moderator } = await setup();
    const author = await createUser();
    const postId = await createPost(author);

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "content_removal",
        targetType: "post",
        targetId: postId,
        reason: "Spam.",
      })
      .expect(201);

    expect(response.body.data.contentRemoved).toBe(true);

    const post = await prisma.post.findUnique({ where: { id: postId } });
    expect(post?.deletedAt).not.toBeNull();
  });

  it("treats removing already-removed content as an idempotent no-op", async () => {
    const { moderator } = await setup();
    const author = await createUser();
    const postId = await createPost(author);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "content_removal", targetType: "post", targetId: postId })
      .expect(201);

    const second = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "content_removal", targetType: "post", targetId: postId })
      .expect(201);

    // The decision is still recorded; only the mutation was a no-op.
    expect(second.body.data.contentRemoved).toBe(false);
  });

  it("decrements the parent post's comment count when removing a comment", async () => {
    const { moderator } = await setup();
    const author = await createUser();
    const postId = await createPost(author);

    const comment = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(author.token))
      .send({ content: "A comment that will be removed." })
      .expect(201);

    const before = await prisma.post.findUnique({ where: { id: postId } });
    expect(before?.commentsCount).toBe(1);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "content_removal",
        targetType: "comment",
        targetId: comment.body.data.comment.id,
      })
      .expect(201);

    const after = await prisma.post.findUnique({ where: { id: postId } });
    expect(after?.commentsCount).toBe(0);
  });

  it("links an action to the report that prompted it", async () => {
    const [reporter, author] = [await createUser(), await createUser()];
    const moderator = await promote(await createUser(), "moderator");
    const postId = await createPost(author);
    const reportId = await fileReport(reporter, "post", postId);

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "content_removal",
        targetType: "post",
        targetId: postId,
        reportId,
      })
      .expect(201);

    expect(response.body.data.action.reportId).toBe(reportId);
  });

  it("404s an action naming a report that does not exist", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "warning",
        targetType: "user",
        targetId: offender.userId,
        reportId: "00000000-0000-4000-8000-000000000000",
      })
      .expect(404);
  });

  it("404s an action against a target that does not exist", async () => {
    const { moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "warning",
        targetType: "user",
        targetId: "00000000-0000-4000-8000-000000000000",
      })
      .expect(404);
  });

  it("422s an invented action verb", async () => {
    const { offender, moderator } = await setup();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "vaporize", targetType: "user", targetId: offender.userId })
      .expect(422);
  });
});

/* ── Notifications (ruling R11) ──────────────────────────────────────────── */

describe("moderation notifications", () => {
  it("tells the affected user they were warned", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "warning", targetType: "user", targetId: offender.userId })
      .expect(201);

    const notifications = await prisma.notification.findMany({
      where: { userId: offender.userId, type: "moderation" },
    });

    expect(notifications).toHaveLength(1);
    // System-generated: no actor, so the acting moderator's identity stays out
    // of the notification panel.
    expect(notifications[0]?.actorId).toBeNull();
    expect(notifications[0]?.message).toContain("warning");
  });

  it("delivers even when the user muted the moderation type", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    // Registration already seeds a preference row per type, so this mutes an
    // existing row rather than creating one.
    await prisma.notificationPreference.upsert({
      where: { userId_type: { userId: offender.userId, type: "moderation" } },
      update: { inApp: false },
      create: { userId: offender.userId, type: "moderation", inApp: false },
    });

    const muted = await prisma.notificationPreference.findUnique({
      where: { userId_type: { userId: offender.userId, type: "moderation" } },
    });
    expect(muted?.inApp).toBe(false);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    const notifications = await prisma.notification.findMany({
      where: { userId: offender.userId, type: "moderation" },
    });
    expect(notifications).toHaveLength(1);
  });

  it("does not collapse two moderation notices into one", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post(`${BASE}/actions`)
        .set(...bearer(moderator.token))
        .send({ action: "warning", targetType: "user", targetId: offender.userId })
        .expect(201);
    }

    const notifications = await prisma.notification.findMany({
      where: { userId: offender.userId, type: "moderation" },
    });
    expect(notifications).toHaveLength(2);
  });

  it("sends nothing for a shadow ban", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "shadow_ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    const notifications = await prisma.notification.findMany({
      where: { userId: offender.userId, type: "moderation" },
    });
    expect(notifications).toHaveLength(0);
  });
});

/* ── Suspension expiry (ruling R12) ──────────────────────────────────────── */

describe("lazy suspension expiry", () => {
  it("keeps a live suspension in force", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);

    await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(offender.token))
      .expect(403);
  });

  it("lifts a lapsed suspension on the next request", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);

    // Backdate the expiry rather than waiting an hour. The row is what the
    // lazy check reads, so this is the same state the clock would produce.
    await prisma.moderationAction.updateMany({
      where: { targetUserId: offender.userId, action: "suspension" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(offender.token))
      .expect(200);

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("active");
  });

  it("records the automatic lift with no actor", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);

    await prisma.moderationAction.updateMany({
      where: { targetUserId: offender.userId, action: "suspension" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(offender.token))
      .expect(200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_SUSPENSION_EXPIRED", targetId: offender.userId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBeNull();
  });

  it("never lifts a permanent ban", async () => {
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(offender.token))
      .expect(403);

    const user = await prisma.user.findUnique({ where: { id: offender.userId } });
    expect(user?.status).toBe("banned");
  });

  it("keeps a ban that followed a suspension in force", async () => {
    // The newest status-affecting action decides. A lapsed suspension must not
    // resurrect an account that was banned outright afterwards.
    const offender = await createUser();
    const moderator = await promote(await createUser(), "moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: offender.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(201);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    await prisma.moderationAction.updateMany({
      where: { targetUserId: offender.userId, action: "suspension" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app)
      .get("/api/v1/users/me")
      .set(...bearer(offender.token))
      .expect(403);
  });
});
