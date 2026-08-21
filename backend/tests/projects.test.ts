import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Projects end to end against real PostgreSQL and Redis.
 *
 * Real infrastructure rather than a mocked Prisma, because most of what Phase
 * 5 promises is a property of transactions: `projectsCount` moving with a
 * create, `progressPercent` deriving from milestone rows, the owner membership
 * landing in the same commit as the project. A mock would assert that the
 * service called a function, not that the invariant held.
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

const NS = "projtest";
const PASSWORD = "ValidPass123";

/** Every key the shipped frontend's `Project` type declares. */
const FRONTEND_PROJECT_KEYS = [
  "coverImageUrl",
  "createdAt",
  "demoUrl",
  "description",
  "documentationUrl",
  "fundingStage",
  "gallery",
  "id",
  "members",
  "metrics",
  "milestones",
  "ownerId",
  "progressPercent",
  "repositoryUrl",
  "slug",
  "status",
  "tags",
  "techStack",
  "title",
  "updatedAt",
].sort();

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

async function createUser(displayName = "Project Tester"): Promise<TestUser> {
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

const TITLE_PREFIX = "Projtest";
let titleCounter = 0;
function uniqueTitle(): string {
  titleCounter += 1;
  return `${TITLE_PREFIX} ${String(titleCounter)} ${String(Date.now())}`;
}

async function createProject(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<{ slug: string; id: string; project: Record<string, unknown> }> {
  const response = await request(app)
    .post("/api/v1/projects")
    .set(...bearer(actor.token))
    .send({ title: uniqueTitle(), ...body })
    .expect(201);

  const project = response.body.data.project as Record<string, unknown>;
  return { slug: project["slug"] as string, id: project["id"] as string, project };
}

async function projectsCountOf(userId: string): Promise<number> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { projectsCount: true },
  });
  return row.projectsCount;
}

let owner: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Project Owner");
  outsider = await createUser("Project Outsider");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // `Tag.usageCount` is a *shared* counter on rows this suite does not own,
    // and deleting a project cascades its `ProjectTag` rows without moving it.
    // Releasing the tags first is what keeps the suite idempotent: without
    // this, every run leaves the seeded taxonomy a few counts higher, and the
    // drift is invisible until someone reads it.
    const attached = await prisma.projectTag.findMany({
      where: { project: { ownerId: { in: ids } } },
      select: { tagId: true },
    });
    for (const { tagId } of attached) {
      await prisma.tag.updateMany({
        where: { id: tagId, usageCount: { gt: 0 } },
        data: { usageCount: { decrement: 1 } },
      });
    }

    // Order matters: `ProjectUpdate.author` and `Project.owner` are both
    // `onDelete: Restrict`, so the content has to go before the accounts.
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

/* ── Creation ───────────────────────────────────────────────────────────── */

describe("Project creation", () => {
  it("creates from a title alone and returns the frontend's contract", async () => {
    const response = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: uniqueTitle() })
      .expect(201);

    const project = response.body.data.project as Record<string, unknown>;

    // Every key `src/types/project.ts` declares must be present, or the
    // shipped project page destructures undefined.
    expect(FRONTEND_PROJECT_KEYS.every((key) => key in project)).toBe(true);
    expect(project["metrics"]).toEqual({ views: 0, likes: 0, followers: 0 });
    expect(project["progressPercent"]).toBe(0);
    expect(project["status"]).toBe("idea");
    expect(project["visibility"]).toBe("public");
  });

  it("derives a lowercase slug from the title (decision J2)", async () => {
    const { project } = await createProject(owner, { title: "Coastline CRM Reborn" });
    expect(project["slug"]).toBe("coastline-crm-reborn");
  });

  it("ignores a client-supplied slug", async () => {
    const { project } = await createProject(owner, {
      title: "Slug Authority Test",
      slug: "chosen-by-client",
    });

    expect(project["slug"]).toBe("slug-authority-test");
  });

  it("suffixes a colliding slug rather than failing", async () => {
    const title = `Collision ${String(Date.now())}`;
    const first = await createProject(owner, { title });
    const second = await createProject(owner, { title });

    expect(second.slug).toBe(`${first.slug}-2`);
  });

  it("creates the owner's membership row in the same commit (decision J8)", async () => {
    const { id, project } = await createProject(owner);

    const members = await prisma.projectMember.findMany({ where: { projectId: id } });
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(owner.userId);
    expect(members[0]?.role).toBe("owner");

    // And the embedded array the frontend reads carries the same fact.
    expect(project["members"]).toEqual([
      expect.objectContaining({ userId: owner.userId, role: "owner" }),
    ]);
  });

  it("increments the owner's projectsCount (decision J9)", async () => {
    const before = await projectsCountOf(owner.userId);
    await createProject(owner);

    expect(await projectsCountOf(owner.userId)).toBe(before + 1);
  });

  it("rejects an unauthenticated create", async () => {
    await request(app)
      .post("/api/v1/projects")
      .send({ title: uniqueTitle() })
      .expect(401);
  });

  it("never persists a client-supplied ownerId", async () => {
    const { project } = await createProject(owner, { ownerId: outsider.userId });
    expect(project["ownerId"]).toBe(owner.userId);
  });
});

/* ── Tags (decision J7) ─────────────────────────────────────────────────── */

describe("Project tags", () => {
  it("attaches existing tags by display name and flattens them to strings", async () => {
    const { project } = await createProject(owner, { tags: ["Open Source", "SaaS"] });

    expect(project["tags"]).toEqual(expect.arrayContaining(["Open Source", "SaaS"]));
  });

  it("accepts a slug as readily as a display name", async () => {
    const { project } = await createProject(owner, { tags: ["open-source"] });
    expect(project["tags"]).toEqual(["Open Source"]);
  });

  it("refuses to invent a tag that does not exist", async () => {
    // Phase 5 attaches to the taxonomy; it does not extend it.
    const response = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: uniqueTitle(), tags: ["Definitely Not A Real Tag"] })
      .expect(422);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("tags");
  });

  it("moves Tag.usageCount with the attachment", async () => {
    const before = await prisma.tag.findUniqueOrThrow({
      where: { slug: "fintech" },
      select: { usageCount: true },
    });

    const { slug } = await createProject(owner, { tags: ["Fintech"] });

    const after = await prisma.tag.findUniqueOrThrow({
      where: { slug: "fintech" },
      select: { usageCount: true },
    });
    expect(after.usageCount).toBe(before.usageCount + 1);

    // …and back down when the tag is detached by a patch.
    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({ tags: [] })
      .expect(200);

    const detached = await prisma.tag.findUniqueOrThrow({
      where: { slug: "fintech" },
      select: { usageCount: true },
    });
    expect(detached.usageCount).toBe(before.usageCount);
  });
});

/* ── Reads ──────────────────────────────────────────────────────────────── */

describe("Project reads", () => {
  it("serves a public project to an anonymous visitor", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);

    expect(response.body.data.project.slug).toBe(slug);
    // No viewer relationship to describe when nobody is signed in.
    expect(response.body.data.viewer).toBeNull();
  });

  it("describes the viewer's relationship for a signed-in caller", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(response.body.data.viewer).toMatchObject({
      isOwner: true,
      isMember: true,
      role: "owner",
      hasLiked: false,
      isFollowing: false,
      canEdit: true,
      canManageMembers: true,
    });
  });

  it("404s an unknown slug", async () => {
    await request(app).get("/api/v1/projects/no-such-project-here").expect(404);
  });

  it("422s a malformed slug before touching the database", async () => {
    await request(app).get("/api/v1/projects/Not_A_Slug").expect(422);
  });

  it("never exposes deletedAt", async () => {
    const { slug } = await createProject(owner);
    const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);

    expect(JSON.stringify(response.body)).not.toContain("deletedAt");
  });
});

/* ── Updates ────────────────────────────────────────────────────────────── */

describe("Project updates", () => {
  it("applies a patch and leaves the slug alone (decision J2)", async () => {
    const { slug } = await createProject(owner, { title: "Original Title Here" });

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({ title: "A Completely New Title", status: "beta" })
      .expect(200);

    expect(response.body.data.project.title).toBe("A Completely New Title");
    expect(response.body.data.project.status).toBe("beta");
    // Renaming would break every existing link to the project.
    expect(response.body.data.project.slug).toBe(slug);
  });

  it("rejects an empty patch rather than performing a no-op write", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({})
      .expect(422);
  });

  it("refuses to let a patch move the counters or the owner", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({
        title: "Legitimate Rename",
        progressPercent: 100,
        likesCount: 9_999,
        viewsCount: 9_999,
        ownerId: outsider.userId,
      })
      .expect(200);

    const project = response.body.data.project as Record<string, unknown>;
    expect(project["progressPercent"]).toBe(0);
    expect(project["metrics"]).toEqual({ views: 0, likes: 0, followers: 0 });
    expect(project["ownerId"]).toBe(owner.userId);
  });

  it("stops a non-member editing the project", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(outsider.token))
      .send({ title: "Hostile Rename" })
      .expect(403);

    expect(response.body.error.code).toBe("AUTHORIZATION_ERROR");
  });
});

/* ── Soft delete (decision J9) ──────────────────────────────────────────── */

describe("Project deletion", () => {
  it("soft-deletes and then reads as not found", async () => {
    const { slug, id } = await createProject(owner);

    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);

    await request(app).get(`/api/v1/projects/${slug}`).expect(404);

    // The row survives — this is a soft delete, not a purge.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it("hides a deleted project even from its own owner", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);

    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(404);
  });

  it("decrements projectsCount, and does not double-count a repeat", async () => {
    const { slug } = await createProject(owner);
    const afterCreate = await projectsCountOf(owner.userId);

    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(await projectsCountOf(owner.userId)).toBe(afterCreate - 1);

    // The second delete resolves to 404 (the project is already gone), so the
    // counter cannot be driven below the number of projects that exist.
    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(404);

    expect(await projectsCountOf(owner.userId)).toBe(afterCreate - 1);
  });

  it("stops a non-owner deleting the project", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(outsider.token))
      .expect(403);
  });
});

/* ── Ownership transfer (decision J8) ───────────────────────────────────── */

describe("Ownership transfer", () => {
  it("moves ownerId, both memberships, and both counters in one operation", async () => {
    const recipient = await createUser("Transfer Recipient");
    const { slug, id } = await createProject(owner);

    const ownerBefore = await projectsCountOf(owner.userId);
    const recipientBefore = await projectsCountOf(recipient.userId);

    const response = await request(app)
      .post(`/api/v1/projects/${slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: recipient.username })
      .expect(200);

    expect(response.body.data.project.ownerId).toBe(recipient.userId);

    const members = await prisma.projectMember.findMany({
      where: { projectId: id },
      select: { userId: true, role: true },
    });

    // Neither source of ownership may drift from the other.
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: recipient.userId, role: "owner" },
        // The previous owner is demoted, not removed — dropping them would
        // erase their contribution history from the team list.
        { userId: owner.userId, role: "collaborator" },
      ]),
    );

    expect(await projectsCountOf(owner.userId)).toBe(ownerBefore - 1);
    expect(await projectsCountOf(recipient.userId)).toBe(recipientBefore + 1);
  });

  it("refuses a transfer from anyone but the owner of record", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/transfer`)
      .set(...bearer(outsider.token))
      .send({ username: outsider.username })
      .expect(403);
  });

  it("409s a transfer to the current owner", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/transfer`)
      .set(...bearer(owner.token))
      .send({ username: owner.username })
      .expect(409);
  });
});

/* ── Listings ───────────────────────────────────────────────────────────── */

describe("Project listings", () => {
  it("paginates and carries the standard pagination block", async () => {
    const response = await request(app)
      .get("/api/v1/projects")
      .query({ limit: 2, page: 1 })
      .expect(200);

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeLessThanOrEqual(2);
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(response.body.pagination.total).toBeGreaterThan(0);
  });

  it("rejects an unindexed sort key", async () => {
    await request(app).get("/api/v1/projects").query({ sort: "views" }).expect(422);
  });

  it("filters by status", async () => {
    await createProject(owner, { status: "launched" });

    const response = await request(app)
      .get("/api/v1/projects")
      .query({ status: "launched", limit: 100 })
      .expect(200);

    const statuses = (response.body.data as { status: string }[]).map((p) => p.status);
    expect(statuses.every((status) => status === "launched")).toBe(true);
  });

  it("returns an empty page for an unknown tag rather than an error", async () => {
    // Filtering is a discovery affordance; 422 on a typo would be hostile.
    const response = await request(app)
      .get("/api/v1/projects")
      .query({ tag: "no-such-tag-anywhere" })
      .expect(200);

    expect(response.body.data).toEqual([]);
    expect(response.body.pagination.total).toBe(0);
  });

  it("serves the trending widget's own flat contract", async () => {
    const response = await request(app)
      .get("/api/v1/projects/trending")
      .query({ limit: 3 })
      .expect(200);

    const projects = response.body.data.projects as Record<string, unknown>[];
    expect(projects.length).toBeLessThanOrEqual(3);

    for (const project of projects) {
      // The dashboard widget reads a flat `likesCount` and a denormalized
      // owner — deliberately not the nested `metrics` shape.
      expect(project).toHaveProperty("likesCount");
      expect(project).toHaveProperty("ownerName");
      expect(project).toHaveProperty("ownerAvatarUrl");
      expect(project).not.toHaveProperty("metrics");
    }
  });

  it("resolves `trending` as a route, never as a slug", async () => {
    const response = await request(app).get("/api/v1/projects/trending").expect(200);
    expect(response.body.data).toHaveProperty("projects");
  });

  it("lists an owner's projects, and serves the pinned grid as top-liked", async () => {
    await createProject(owner);

    const response = await request(app)
      .get(`/api/v1/users/${owner.username}/projects`)
      .query({ sort: "trending", limit: 3 })
      .expect(200);

    expect(response.body.data.length).toBeLessThanOrEqual(3);
    expect(
      (response.body.data as { ownerId: string }[]).every(
        (p) => p.ownerId === owner.userId,
      ),
    ).toBe(true);
  });

  it("404s an owner listing for a user who does not exist", async () => {
    await request(app).get("/api/v1/users/nosuchuser.here/projects").expect(404);
  });
});
