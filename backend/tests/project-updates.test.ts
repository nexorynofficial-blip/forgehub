import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The project changelog, and engagement (likes, followers, views).
 *
 * Real Redis matters here as much as real Postgres: view deduplication is a
 * `SET … NX EX` against a live server (decision J6), and a mocked client would
 * assert the call shape rather than the property that actually matters — that
 * the same reader cannot inflate a counter by refreshing.
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

const NS = "updtest";
const PASSWORD = "ValidPass123";

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

async function createUser(displayName = "Update Tester"): Promise<TestUser> {
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

let titleCounter = 0;
async function createProject(actor: TestUser): Promise<string> {
  titleCounter += 1;
  const response = await request(app)
    .post("/api/v1/projects")
    .set(...bearer(actor.token))
    .send({ title: `Updtest ${String(titleCounter)} ${String(Date.now())}` })
    .expect(201);

  return response.body.data.project.slug as string;
}

async function postUpdate(
  actor: TestUser,
  slug: string,
  content: string,
): Promise<string> {
  const response = await request(app)
    .post(`/api/v1/projects/${slug}/updates`)
    .set(...bearer(actor.token))
    .send({ content })
    .expect(201);

  return response.body.data.update.id as string;
}

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Changelog Owner");
  member = await createUser("Changelog Member");
  outsider = await createUser("Changelog Outsider");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.projectUpdate.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Changelog ──────────────────────────────────────────────────────────── */

describe("Project updates", () => {
  it("posts an update joined with its author", async () => {
    const slug = await createProject(owner);

    const response = await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "Shipped the new onboarding flow." })
      .expect(201);

    expect(response.body.data.update).toMatchObject({
      content: "Shipped the new onboarding flow.",
      authorId: owner.userId,
      author: { username: owner.username, displayName: "Changelog Owner" },
    });
  });

  it("never lets a client choose the author", async () => {
    const slug = await createProject(owner);

    const response = await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "Real content", authorId: outsider.userId })
      .expect(201);

    expect(response.body.data.update.authorId).toBe(owner.userId);
  });

  it("cursor-paginates newest first", async () => {
    const slug = await createProject(owner);
    for (const n of [1, 2, 3]) await postUpdate(owner, slug, `Update ${String(n)}`);

    const first = await request(app)
      .get(`/api/v1/projects/${slug}/updates`)
      .query({ limit: 2 })
      .expect(200);

    expect(first.body.data.updates).toHaveLength(2);
    expect(first.body.data.updates[0].content).toBe("Update 3");
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`/api/v1/projects/${slug}/updates`)
      .query({ limit: 2, cursor: first.body.data.nextCursor })
      .expect(200);

    expect(second.body.data.updates).toHaveLength(1);
    expect(second.body.data.updates[0].content).toBe("Update 1");
    expect(second.body.data.nextCursor).toBeNull();
  });

  it("lets a contributor post but only edit their own", async () => {
    const slug = await createProject(owner);
    await request(app)
      .post(`/api/v1/projects/${slug}/members`)
      .set(...bearer(owner.token))
      .send({ username: member.username, role: "contributor" })
      .expect(201);

    const mine = await postUpdate(member, slug, "My own update");
    const theirs = await postUpdate(owner, slug, "The owner's update");

    // A contributor holds no `moderate_updates` grant, but authorship is
    // checked separately so they can still fix their own typo.
    await request(app)
      .patch(`/api/v1/projects/${slug}/updates/${mine}`)
      .set(...bearer(member.token))
      .send({ content: "My own update, corrected" })
      .expect(200);

    await request(app)
      .patch(`/api/v1/projects/${slug}/updates/${theirs}`)
      .set(...bearer(member.token))
      .send({ content: "Hijacked" })
      .expect(403);
  });

  it("lets the owner moderate anyone's update", async () => {
    const slug = await createProject(owner);
    await request(app)
      .post(`/api/v1/projects/${slug}/members`)
      .set(...bearer(owner.token))
      .send({ username: member.username, role: "contributor" })
      .expect(201);

    const theirs = await postUpdate(member, slug, "Member update");

    await request(app)
      .delete(`/api/v1/projects/${slug}/updates/${theirs}`)
      .set(...bearer(owner.token))
      .expect(200);
  });

  it("soft-deletes, so the update leaves the list but not the table", async () => {
    const slug = await createProject(owner);
    const id = await postUpdate(owner, slug, "Temporary");

    await request(app)
      .delete(`/api/v1/projects/${slug}/updates/${id}`)
      .set(...bearer(owner.token))
      .expect(200);

    const list = await request(app).get(`/api/v1/projects/${slug}/updates`).expect(200);
    expect(list.body.data.updates).toHaveLength(0);

    const row = await prisma.projectUpdate.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it("stops a non-member posting", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(outsider.token))
      .send({ content: "Not my project" })
      .expect(403);
  });

  it("rejects empty and oversized content", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "   " })
      .expect(422);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "x".repeat(5_001) })
      .expect(422);
  });
});

/* ── Likes and followers ────────────────────────────────────────────────── */

describe("Project likes", () => {
  it("likes, reports the counter, and 409s a duplicate", async () => {
    const slug = await createProject(owner);

    const liked = await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(outsider.token))
      .expect(201);

    expect(liked.body.data).toMatchObject({ liked: true });
    expect(liked.body.data.metrics.likes).toBe(1);

    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(outsider.token))
      .expect(409);
  });

  it("unlikes idempotently without driving the counter negative", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(outsider.token))
      .expect(201);

    for (const _ of [1, 2, 3]) {
      const response = await request(app)
        .delete(`/api/v1/projects/${slug}/like`)
        .set(...bearer(outsider.token))
        .expect(200);

      expect(response.body.data.metrics.likes).toBe(0);
    }
  });

  it("lets an owner like their own project", async () => {
    // Unlike self-following a user, this is ordinary behaviour and nothing
    // downstream divides by it.
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(owner.token))
      .expect(201);
  });

  it("reports hasLiked back through the project's viewer block", async () => {
    const slug = await createProject(owner);
    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(outsider.token))
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect(response.body.data.viewer.hasLiked).toBe(true);
  });

  it("requires authentication", async () => {
    const slug = await createProject(owner);
    await request(app).post(`/api/v1/projects/${slug}/like`).expect(401);
  });
});

describe("Project followers", () => {
  it("follows, unfollows, and keeps the counter honest", async () => {
    const slug = await createProject(owner);

    const followed = await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(outsider.token))
      .expect(201);
    expect(followed.body.data.metrics.followers).toBe(1);

    await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(outsider.token))
      .expect(409);

    const unfollowed = await request(app)
      .delete(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(outsider.token))
      .expect(200);
    expect(unfollowed.body.data.metrics.followers).toBe(0);
  });
});

/* ── Views (decision J6) ────────────────────────────────────────────────── */

describe("Project views", () => {
  it("counts a reader once per 24 hours, however often they refresh", async () => {
    const slug = await createProject(owner);

    const first = await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect(first.body.data.counted).toBe(true);
    expect(first.body.data.metrics.views).toBe(1);

    const second = await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect(second.body.data.counted).toBe(false);
    expect(second.body.data.metrics.views).toBe(1);
  });

  it("counts distinct readers separately", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(outsider.token))
      .expect(200);

    const second = await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(member.token))
      .expect(200);

    expect(second.body.data.counted).toBe(true);
    expect(second.body.data.metrics.views).toBe(2);
  });

  it("does not count the owner viewing their own project", async () => {
    const slug = await createProject(owner);

    const response = await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(response.body.data.counted).toBe(false);
    expect(response.body.data.metrics.views).toBe(0);
  });

  it("accepts an anonymous view, deduplicated by source address", async () => {
    const slug = await createProject(owner);

    const first = await request(app).post(`/api/v1/projects/${slug}/view`).expect(200);
    expect(first.body.data.counted).toBe(true);

    const second = await request(app).post(`/api/v1/projects/${slug}/view`).expect(200);
    expect(second.body.data.counted).toBe(false);
  });

  it("offers no unrestricted increment: a hidden project cannot be viewed", async () => {
    const slug = await createProject(owner);
    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({ visibility: "private" })
      .expect(200);

    await request(app)
      .post(`/api/v1/projects/${slug}/view`)
      .set(...bearer(outsider.token))
      .expect(404);
  });
});
