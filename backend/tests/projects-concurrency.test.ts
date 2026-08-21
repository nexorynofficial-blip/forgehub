import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Counter correctness under genuine concurrency.
 *
 * Every test here fires real simultaneous HTTP requests against real
 * PostgreSQL. That is the point: the guarantees Phase 5 relies on are
 * properties of unique indexes and row locks, and a mocked Prisma would report
 * that a function was called rather than that a counter survived the race.
 *
 * Three mechanisms are under test, all inherited from the Phase 4 follow graph:
 *
 *   - the composite primary key as the arbiter between duplicate writes,
 *   - `{ increment: 1 }` compiling to `SET x = x + 1` under a row lock,
 *   - decrements gated on a row actually having been deleted.
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

const NS = "conctest";
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

async function createUser(displayName = "Concurrency Tester"): Promise<TestUser> {
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
async function createProject(actor: TestUser): Promise<{ slug: string; id: string }> {
  titleCounter += 1;
  const response = await request(app)
    .post("/api/v1/projects")
    .set(...bearer(actor.token))
    .send({ title: `Conctest ${String(titleCounter)} ${String(Date.now())}` })
    .expect(201);

  return {
    slug: response.body.data.project.slug as string,
    id: response.body.data.project.id as string,
  };
}

async function counters(projectId: string) {
  return prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { likesCount: true, followersCount: true, viewsCount: true },
  });
}

let owner: TestUser;
let likers: TestUser[];

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Concurrency Owner");
  likers = await Promise.all(
    Array.from({ length: 6 }, (_, i) => createUser(`Liker ${String(i)}`)),
  );
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

describe("Simultaneous identical likes", () => {
  it("commits exactly one, and moves the counter exactly once", async () => {
    const { slug, id } = await createProject(owner);
    const liker = likers[0]!;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/api/v1/projects/${slug}/like`)
          .set(...bearer(liker.token)),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);

    // The composite primary key is the arbiter: one insert commits, the other
    // seven raise P2002 and roll back — including their counter increments.
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);

    const rows = await prisma.projectLike.count({ where: { projectId: id } });
    expect(rows).toBe(1);
    expect((await counters(id)).likesCount).toBe(1);
  });
});

describe("Simultaneous distinct likers", () => {
  it("counts every one, losing no update", async () => {
    const { slug, id } = await createProject(owner);

    const results = await Promise.all(
      likers.map((liker) =>
        request(app)
          .post(`/api/v1/projects/${slug}/like`)
          .set(...bearer(liker.token)),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    // `SET x = x + 1` under a row lock, not a read-modify-write: six different
    // likers serialize rather than clobbering each other.
    expect((await counters(id)).likesCount).toBe(likers.length);
  });
});

describe("Interleaved likes and unlikes", () => {
  it("never drives the counter negative", async () => {
    const { slug, id } = await createProject(owner);
    const liker = likers[0]!;

    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(liker.token))
      .expect(201);

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        request(app)
          .delete(`/api/v1/projects/${slug}/like`)
          .set(...bearer(liker.token)),
      ),
      ...Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/projects/${slug}/like`)
          .set(...bearer(liker.token)),
      ),
    ]);

    const final = await counters(id);
    const rows = await prisma.projectLike.count({ where: { projectId: id } });

    // Whatever order they landed in, the counter must equal the row count and
    // must never have gone below zero.
    expect(final.likesCount).toBeGreaterThanOrEqual(0);
    expect(final.likesCount).toBe(rows);
  });
});

describe("Simultaneous follows", () => {
  it("commits one row per follower and matches the counter", async () => {
    const { slug, id } = await createProject(owner);

    await Promise.all(
      likers.map((user) =>
        request(app)
          .post(`/api/v1/projects/${slug}/follow`)
          .set(...bearer(user.token)),
      ),
    );

    const rows = await prisma.projectFollower.count({ where: { projectId: id } });
    expect(rows).toBe(likers.length);
    expect((await counters(id)).followersCount).toBe(likers.length);
  });
});

describe("Simultaneous member adds", () => {
  it("creates one membership and refuses the rest with 409", async () => {
    const { slug, id } = await createProject(owner);
    const target = likers[1]!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/projects/${slug}/members`)
          .set(...bearer(owner.token))
          .send({ username: target.username, role: "collaborator" }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const memberships = await prisma.projectMember.count({
      where: { projectId: id, userId: target.userId },
    });
    expect(memberships).toBe(1);
  });
});

describe("Simultaneous creates with the same title", () => {
  it("produces distinct slugs rather than a 500", async () => {
    // The slug collision path retries the whole transaction with the next
    // candidate; an in-transaction retry would run inside a failed block.
    const title = `Race Title ${String(Date.now())}`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(app)
          .post("/api/v1/projects")
          .set(...bearer(owner.token))
          .send({ title }),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const slugs = results.map((r) => r.body.data.project.slug as string);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("Simultaneous view records", () => {
  it("counts a single reader once despite parallel requests", async () => {
    // `SET … NX EX` is atomic, so "is this a new view?" cannot be won twice.
    const { slug, id } = await createProject(owner);
    const reader = likers[2]!;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/api/v1/projects/${slug}/view`)
          .set(...bearer(reader.token)),
      ),
    );

    const counted = results.filter((r) => r.body.data.counted === true);
    expect(counted).toHaveLength(1);
    expect((await counters(id)).viewsCount).toBe(1);
  });
});

describe("Simultaneous milestone completion", () => {
  it("leaves progressPercent consistent with the milestone rows", async () => {
    const { slug, id } = await createProject(owner);

    const ids = await Promise.all(
      ["One", "Two", "Three", "Four"].map(async (title) => {
        const response = await request(app)
          .post(`/api/v1/projects/${slug}/milestones`)
          .set(...bearer(owner.token))
          .send({ title })
          .expect(201);
        return response.body.data.milestone.id as string;
      }),
    );

    await Promise.all(
      ids.slice(0, 2).map((milestoneId) =>
        request(app)
          .patch(`/api/v1/projects/${slug}/milestones/${milestoneId}`)
          .set(...bearer(owner.token))
          .send({ isComplete: true }),
      ),
    );

    const [project, total, complete] = await Promise.all([
      prisma.project.findUniqueOrThrow({
        where: { id },
        select: { progressPercent: true },
      }),
      prisma.projectMilestone.count({ where: { projectId: id } }),
      prisma.projectMilestone.count({ where: { projectId: id, isComplete: true } }),
    ]);

    // The derived figure must agree with the rows it is derived from, whatever
    // order the concurrent recomputations committed in.
    expect(project.progressPercent).toBe(Math.round((complete / total) * 100));
  });
});
