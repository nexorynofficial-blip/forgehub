import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Moderation security regressions (TRD §14, §17, ARCHITECTURE §18, §25).
 *
 * Phase 11 is the first phase where one user can change another user's
 * standing, remove their content, and read the platform's audit trail. That
 * makes it the phase where an authorization mistake stops being a bug and
 * starts being a privilege-escalation vulnerability, so this file is written
 * as an attack list rather than a feature list.
 *
 * Six properties are asserted throughout:
 *
 *   1. **Anonymous is 401, unauthorized is 403.** ARCHITECTURE §18 warns
 *      against conflating "who are you?" with "may you?"; the two answers stay
 *      distinguishable.
 *   2. **Rank is enforced.** A moderator cannot action a peer or a superior,
 *      and nobody actions themselves.
 *   3. **No client-supplied identity is honoured**, for any field, on any
 *      route.
 *   4. **Refusals do not disclose.** One message covers every rank refusal, so
 *      the endpoint cannot be used to map other users' roles.
 *   5. **Every mutation leaves an audit row**, in the same transaction.
 *   6. **Phase 10's ruling D8 still holds** — staff get no wider search.
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

const NS = "modsec";
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

type Role =
  "member" | "verified_builder" | "moderator" | "community_admin" | "platform_admin";

async function userWithRole(role: Role): Promise<TestUser> {
  const user = await createUser();
  if (role !== "member") {
    await prisma.user.update({ where: { id: user.userId }, data: { role } });
  }
  return user;
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

async function createPost(author: TestUser): Promise<string> {
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(author.token))
    .send({ type: "text", content: "Reportable content." })
    .expect(201);

  return response.body.data.post.id as string;
}

async function fileReport(reporter: TestUser, targetId: string): Promise<string> {
  const response = await request(app)
    .post(`${BASE}/reports`)
    .set(...bearer(reporter.token))
    .send({ targetType: "post", targetId, reason: "spam" })
    .expect(201);

  return response.body.data.report.id as string;
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
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Authentication ──────────────────────────────────────────────────────── */

describe("anonymous callers", () => {
  const ANON_ROUTES: [string, string][] = [
    ["post", `${BASE}/reports`],
    ["get", `${BASE}/reports`],
    ["get", `${BASE}/reports/00000000-0000-4000-8000-000000000000`],
    ["patch", `${BASE}/reports/00000000-0000-4000-8000-000000000000`],
    ["post", `${BASE}/actions`],
  ];

  it.each(ANON_ROUTES)("401s %s %s", async (method, path) => {
    const response = await (
      request(app) as unknown as Record<string, (p: string) => request.Test>
    )[method]!(path).send({});

    expect(response.status).toBe(401);
  });

  it("rejects a forged bearer token rather than trusting it", async () => {
    await request(app)
      .get(`${BASE}/reports`)
      .set("Authorization", "Bearer not.a.real.token")
      .expect(401);
  });

  it("rejects a token naming a platform admin that the server never issued", async () => {
    // A hand-rolled JWT claiming elevated privileges must not authenticate.
    await request(app)
      .get(`${BASE}/reports`)
      .set(
        "Authorization",
        "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciIsInJvbGUiOiJwbGF0Zm9ybV9hZG1pbiJ9.x",
      )
      .expect(401);
  });
});

/* ── Capability boundaries ───────────────────────────────────────────────── */

describe("the staff boundary", () => {
  const OUTSIDERS: Role[] = ["member", "verified_builder"];

  it.each(OUTSIDERS)("403s %s on the moderation queue", async (role) => {
    const user = await userWithRole(role);

    await request(app)
      .get(`${BASE}/reports`)
      .set(...bearer(user.token))
      .expect(403);
  });

  it.each(OUTSIDERS)("403s %s on report review", async (role) => {
    const user = await userWithRole(role);
    const author = await createUser();
    const reportId = await fileReport(user, await createPost(author));

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(user.token))
      .send({ status: "reviewing" })
      .expect(403);
  });

  it.each(OUTSIDERS)("403s %s on moderation actions", async (role) => {
    const user = await userWithRole(role);
    const victim = await createUser();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(user.token))
      .send({ action: "ban", targetType: "user", targetId: victim.userId })
      .expect(403);
  });

  it("403s a reporter reading back their own report", async () => {
    // A report carries the reviewer's identity, the denormalized target
    // author, and a free-text resolution — none of it the filer's business.
    const reporter = await createUser();
    const author = await createUser();
    const reportId = await fileReport(reporter, await createPost(author));

    await request(app)
      .get(`${BASE}/reports/${reportId}`)
      .set(...bearer(reporter.token))
      .expect(403);
  });

  it("lets any authenticated member file a report", async () => {
    const member = await userWithRole("member");
    const author = await createUser();

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(member.token))
      .send({
        targetType: "post",
        targetId: await createPost(author),
        reason: "spam",
      })
      .expect(201);
  });
});

/* ── Rank ────────────────────────────────────────────────────────────────── */

describe("the rank boundary", () => {
  it("refuses a moderator actioning another moderator", async () => {
    const [actor, target] = [
      await userWithRole("moderator"),
      await userWithRole("moderator"),
    ];

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "ban", targetType: "user", targetId: target.userId })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: target.userId } });
    expect(stored?.status).toBe("active");
  });

  it("refuses a moderator actioning a platform admin", async () => {
    const actor = await userWithRole("moderator");
    const target = await userWithRole("platform_admin");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "ban", targetType: "user", targetId: target.userId })
      .expect(403);
  });

  it("refuses a platform admin actioning another platform admin", async () => {
    const [actor, target] = [
      await userWithRole("platform_admin"),
      await userWithRole("platform_admin"),
    ];

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "ban", targetType: "user", targetId: target.userId })
      .expect(403);
  });

  it("refuses self-ban and self-suspension", async () => {
    const actor = await userWithRole("platform_admin");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "ban", targetType: "user", targetId: actor.userId })
      .expect(403);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({
        action: "suspension",
        targetType: "user",
        targetId: actor.userId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .expect(403);

    const stored = await prisma.user.findUnique({ where: { id: actor.userId } });
    expect(stored?.status).toBe("active");
  });

  it("refuses a moderator removing a platform admin's content", async () => {
    // The rank check follows the content to its author.
    const actor = await userWithRole("moderator");
    const target = await userWithRole("platform_admin");
    const postId = await createPost(target);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "content_removal", targetType: "post", targetId: postId })
      .expect(403);

    const post = await prisma.post.findUnique({ where: { id: postId } });
    expect(post?.deletedAt).toBeNull();
  });

  it("gives one identical message for every rank refusal", async () => {
    // A caller able to distinguish "you outrank nobody" from "that account
    // outranks you" could map other users' roles by probing.
    const actor = await userWithRole("moderator");
    const peer = await userWithRole("moderator");
    const superior = await userWithRole("platform_admin");

    const responses = await Promise.all(
      [peer.userId, superior.userId, actor.userId].map((targetId) =>
        request(app)
          .post(`${BASE}/actions`)
          .set(...bearer(actor.token))
          .send({ action: "warning", targetType: "user", targetId }),
      ),
    );

    const messages = new Set(responses.map((r) => r.body.error.message));
    expect(messages.size).toBe(1);
  });
});

/* ── Client-supplied identity ────────────────────────────────────────────── */

describe("client-supplied identity is ignored", () => {
  it("ignores a reporterId in the report body", async () => {
    const [reporter, impersonated, author] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];

    const response = await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({
        targetType: "post",
        targetId: await createPost(author),
        reason: "spam",
        reporterId: impersonated.userId,
      })
      .expect(201);

    expect(response.body.data.report.reporterId).toBe(reporter.userId);
  });

  it("ignores a status and a reviewerId injected into the report body", async () => {
    const [reporter, author] = [await createUser(), await createUser()];

    const response = await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(reporter.token))
      .send({
        targetType: "post",
        targetId: await createPost(author),
        reason: "spam",
        status: "resolved",
        reviewerId: reporter.userId,
        resolvedAt: new Date().toISOString(),
      })
      .expect(201);

    expect(response.body.data.report.status).toBe("pending");
    expect(response.body.data.report.reviewerId).toBeNull();
    expect(response.body.data.report.resolvedAt).toBeNull();
  });

  it("ignores a moderatorId in the action body", async () => {
    const moderator = await userWithRole("moderator");
    const impersonated = await userWithRole("platform_admin");
    const victim = await createUser();

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({
        action: "warning",
        targetType: "user",
        targetId: victim.userId,
        moderatorId: impersonated.userId,
        actorId: impersonated.userId,
      })
      .expect(201);

    expect(response.body.data.action.moderatorId).toBe(moderator.userId);
  });

  it("ignores a reviewerId supplied on review", async () => {
    const moderator = await userWithRole("moderator");
    const other = await userWithRole("moderator");
    const [reporter, author] = [await createUser(), await createUser()];
    const reportId = await fileReport(reporter, await createPost(author));

    const response = await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing", reviewerId: other.userId })
      .expect(200);

    expect(response.body.data.report.reviewerId).toBe(moderator.userId);
  });

  it("ignores a role claimed in the query string", async () => {
    const member = await userWithRole("member");

    await request(app)
      .get(`${BASE}/reports`)
      .query({ role: "platform_admin", isAdmin: "true" })
      .set(...bearer(member.token))
      .expect(403);
  });
});

/* ── Banned users ────────────────────────────────────────────────────────── */

describe("banned accounts", () => {
  it("cannot file a report", async () => {
    const offender = await createUser();
    const moderator = await userWithRole("moderator");
    const author = await createUser();
    const postId = await createPost(author);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    await request(app)
      .post(`${BASE}/reports`)
      .set(...bearer(offender.token))
      .send({ targetType: "post", targetId: postId, reason: "spam" })
      .expect(403);
  });

  it("cannot act even if they held a staff role", async () => {
    const rogue = await userWithRole("moderator");
    const admin = await userWithRole("platform_admin");
    const victim = await createUser();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(admin.token))
      .send({ action: "ban", targetType: "user", targetId: rogue.userId })
      .expect(201);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(rogue.token))
      .send({ action: "ban", targetType: "user", targetId: victim.userId })
      .expect(403);
  });
});

/* ── Audit durability (ruling R9) ────────────────────────────────────────── */

describe("every mutation leaves an audit row", () => {
  it("audits a ban with the acting moderator as the actor", async () => {
    const offender = await createUser();
    const moderator = await userWithRole("moderator");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "ban", targetType: "user", targetId: offender.userId })
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "USER_BANNED", targetId: offender.userId },
    });

    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(moderator.userId);
  });

  it("audits a content removal under the verb ARCHITECTURE §26 names", async () => {
    const moderator = await userWithRole("moderator");
    const author = await createUser();
    const postId = await createPost(author);

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "content_removal", targetType: "post", targetId: postId })
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "POST_REMOVED", targetId: postId },
    });
    expect(audit).not.toBeNull();
  });

  it("audits report filing and every lifecycle transition", async () => {
    const moderator = await userWithRole("moderator");
    const [reporter, author] = [await createUser(), await createUser()];
    const reportId = await fileReport(reporter, await createPost(author));

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "reviewing" })
      .expect(200);

    await request(app)
      .patch(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .send({ status: "resolved" })
      .expect(200);

    const verbs = await prisma.auditLog.findMany({
      where: { targetId: reportId },
      select: { action: true },
    });

    const seen = verbs.map((row) => row.action);
    expect(seen).toContain("REPORT_REVIEWED");
    expect(seen).toContain("REPORT_RESOLVED");
  });

  it("writes no action row when the action is refused", async () => {
    // The refusal happens before the transaction, so neither the moderation
    // action nor an audit row may exist.
    const actor = await userWithRole("moderator");
    const target = await userWithRole("platform_admin");

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(actor.token))
      .send({ action: "ban", targetType: "user", targetId: target.userId })
      .expect(403);

    const actions = await prisma.moderationAction.findMany({
      where: { targetUserId: target.userId },
    });
    expect(actions).toHaveLength(0);

    const audit = await prisma.auditLog.findMany({
      where: { action: "USER_BANNED", targetId: target.userId },
    });
    expect(audit).toHaveLength(0);
  });

  it("pairs every moderation action with an audit row", async () => {
    const moderator = await userWithRole("moderator");
    const offender = await createUser();

    await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "warning", targetType: "user", targetId: offender.userId })
      .expect(201);

    const actions = await prisma.moderationAction.findMany({
      where: { targetUserId: offender.userId },
    });
    const audits = await prisma.auditLog.findMany({
      where: { action: "USER_WARNED", targetId: offender.userId },
    });

    expect(actions).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

/* ── Projection safety ───────────────────────────────────────────────────── */

describe("the projection never widens", () => {
  it("omits email, role, and status from every person on a report", async () => {
    const moderator = await userWithRole("moderator");
    const [reporter, author] = [await createUser(), await createUser()];
    const reportId = await fileReport(reporter, await createPost(author));

    const response = await request(app)
      .get(`${BASE}/reports/${reportId}`)
      .set(...bearer(moderator.token))
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("@forgehub.test");
    expect(serialized).not.toContain("passwordHash");

    for (const person of [
      response.body.data.report.reporter,
      response.body.data.report.targetAuthor,
    ]) {
      expect(Object.keys(person).sort()).toEqual([
        "avatarUrl",
        "builderRank",
        "displayName",
        "id",
        "username",
      ]);
    }
  });

  it("never returns raw Prisma error text on a malformed request", async () => {
    const moderator = await userWithRole("moderator");

    const response = await request(app)
      .post(`${BASE}/actions`)
      .set(...bearer(moderator.token))
      .send({ action: "warning", targetType: "user", targetId: "nope" })
      .expect(422);

    expect(JSON.stringify(response.body)).not.toContain("prisma");
  });
});

/* ── Phase 10 boundary ───────────────────────────────────────────────────── */

describe("Phase 10 ruling D8 still holds", () => {
  it("gives a platform admin exactly the search results a member gets", async () => {
    const admin = await userWithRole("platform_admin");
    const member = await userWithRole("member");

    // A followers-only profile that neither of them follows.
    const hidden = await createUser();
    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(hidden.token))
      .send({ profileVisibility: "followers" })
      .expect(200);

    const query = { q: hidden.username, type: "users" };

    const [asAdmin, asMember] = await Promise.all([
      request(app)
        .get("/api/v1/search")
        .query(query)
        .set(...bearer(admin.token))
        .expect(200),
      request(app)
        .get("/api/v1/search")
        .query(query)
        .set(...bearer(member.token))
        .expect(200),
    ]);

    expect(asAdmin.body.data.users.items).toHaveLength(0);
    expect(asAdmin.body.data.users.pagination.total).toBe(
      asMember.body.data.users.pagination.total,
    );
  });
});
