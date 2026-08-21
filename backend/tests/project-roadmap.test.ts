import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The project roadmap, and the derived `progressPercent` (decision J3).
 *
 * Every assertion about the percentage is really an assertion about a
 * transaction: the figure is recomputed inside the same commit as the
 * milestone write, so it can never disagree with the roadmap a client is
 * looking at. A mocked Prisma would prove none of that.
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

const NS = "roadtest";
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

async function createUser(displayName = "Roadmap Tester"): Promise<TestUser> {
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
    .send({ title: `Roadtest ${String(titleCounter)} ${String(Date.now())}` })
    .expect(201);

  return response.body.data.project.slug as string;
}

async function addMilestone(
  actor: TestUser,
  slug: string,
  body: Record<string, unknown>,
): Promise<{ id: string; progressPercent: number }> {
  const response = await request(app)
    .post(`/api/v1/projects/${slug}/milestones`)
    .set(...bearer(actor.token))
    .send(body)
    .expect(201);

  return {
    id: response.body.data.milestone.id as string,
    progressPercent: response.body.data.progressPercent as number,
  };
}

async function projectProgress(slug: string): Promise<number> {
  const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);
  return response.body.data.project.progressPercent as number;
}

let owner: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Roadmap Owner");
  outsider = await createUser("Roadmap Outsider");
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

describe("Derived progress (decision J3)", () => {
  it("reports 0% for a project with no milestones", async () => {
    // An empty roadmap is the start of a project, not a finished one.
    const slug = await createProject(owner);
    expect(await projectProgress(slug)).toBe(0);
  });

  it("reports 67% for two of three complete — the seed's own case", async () => {
    // This is the exact figure decision J3 predicts for the seeded projects
    // that previously stored a hand-written 85% and 64%.
    const slug = await createProject(owner);

    await addMilestone(owner, slug, { title: "Private alpha", isComplete: true });
    await addMilestone(owner, slug, { title: "Public beta", isComplete: true });
    const third = await addMilestone(owner, slug, { title: "1.0 launch" });

    expect(third.progressPercent).toBe(67);
    expect(await projectProgress(slug)).toBe(67);
  });

  it("reaches 100% only when every milestone is complete", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "Only step", isComplete: true });

    expect(await projectProgress(slug)).toBe(100);
  });

  it("recomputes when a milestone is completed", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "One" });
    const two = await addMilestone(owner, slug, { title: "Two" });

    expect(await projectProgress(slug)).toBe(0);

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}/milestones/${two.id}`)
      .set(...bearer(owner.token))
      .send({ isComplete: true })
      .expect(200);

    expect(response.body.data.progressPercent).toBe(50);
    expect(await projectProgress(slug)).toBe(50);
  });

  it("recomputes when a milestone is un-completed", async () => {
    const slug = await createProject(owner);
    const one = await addMilestone(owner, slug, { title: "One", isComplete: true });
    expect(await projectProgress(slug)).toBe(100);

    await request(app)
      .patch(`/api/v1/projects/${slug}/milestones/${one.id}`)
      .set(...bearer(owner.token))
      .send({ isComplete: false })
      .expect(200);

    expect(await projectProgress(slug)).toBe(0);
  });

  it("recomputes when a milestone is deleted", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "Done", isComplete: true });
    const pending = await addMilestone(owner, slug, { title: "Pending" });

    expect(await projectProgress(slug)).toBe(50);

    await request(app)
      .delete(`/api/v1/projects/${slug}/milestones/${pending.id}`)
      .set(...bearer(owner.token))
      .expect(200);

    // Removing the incomplete half leaves a fully complete roadmap.
    expect(await projectProgress(slug)).toBe(100);
  });

  it("returns to 0% when the last milestone is deleted", async () => {
    const slug = await createProject(owner);
    const only = await addMilestone(owner, slug, { title: "Only", isComplete: true });

    await request(app)
      .delete(`/api/v1/projects/${slug}/milestones/${only.id}`)
      .set(...bearer(owner.token))
      .expect(200);

    expect(await projectProgress(slug)).toBe(0);
  });
});

describe("Milestone lifecycle", () => {
  it("maintains completedAt rather than accepting it from a client", async () => {
    const slug = await createProject(owner);
    const created = await addMilestone(owner, slug, { title: "Ship it" });

    const before = await request(app)
      .get(`/api/v1/projects/${slug}/milestones`)
      .expect(200);
    expect(before.body.data.milestones[0].completedAt).toBeNull();

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}/milestones/${created.id}`)
      .set(...bearer(owner.token))
      .send({ isComplete: true, completedAt: "1999-01-01T00:00:00.000Z" })
      .expect(200);

    // Set by the server to now, not to the value the client asserted.
    const completedAt = response.body.data.milestone.completedAt as string;
    expect(completedAt).not.toBeNull();
    expect(new Date(completedAt).getFullYear()).toBeGreaterThan(2020);
  });

  it("orders milestones by position, which is the render order", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "Third", position: 2 });
    await addMilestone(owner, slug, { title: "First", position: 0 });
    await addMilestone(owner, slug, { title: "Second", position: 1 });

    const response = await request(app)
      .get(`/api/v1/projects/${slug}/milestones`)
      .expect(200);

    const titles = (response.body.data.milestones as { title: string }[]).map(
      (m) => m.title,
    );
    expect(titles).toEqual(["First", "Second", "Third"]);
  });

  it("appends without an explicit position", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "One" });
    await addMilestone(owner, slug, { title: "Two" });

    const response = await request(app)
      .get(`/api/v1/projects/${slug}/milestones`)
      .expect(200);

    const positions = (response.body.data.milestones as { position: number }[]).map(
      (m) => m.position,
    );
    expect(positions).toEqual([0, 1]);
  });

  it("404s a milestone id belonging to another project", async () => {
    // Scoped lookup: holding write access to *some* project must not grant
    // write access to another project's rows.
    const mine = await createProject(owner);
    const theirs = await createProject(owner);
    const foreign = await addMilestone(owner, theirs, { title: "Theirs" });

    await request(app)
      .patch(`/api/v1/projects/${mine}/milestones/${foreign.id}`)
      .set(...bearer(owner.token))
      .send({ title: "Hijacked" })
      .expect(404);
  });

  it("422s a malformed milestone id", async () => {
    const slug = await createProject(owner);

    await request(app)
      .delete(`/api/v1/projects/${slug}/milestones/not-a-uuid`)
      .set(...bearer(owner.token))
      .expect(422);
  });
});

describe("Roadmap authorization", () => {
  it("lets anyone read a public project's roadmap", async () => {
    const slug = await createProject(owner);
    await addMilestone(owner, slug, { title: "Public step" });

    const response = await request(app)
      .get(`/api/v1/projects/${slug}/milestones`)
      .expect(200);

    expect(response.body.data.milestones).toHaveLength(1);
  });

  it("stops a non-member writing to the roadmap", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/milestones`)
      .set(...bearer(outsider.token))
      .send({ title: "Hostile milestone" })
      .expect(403);
  });

  it("requires authentication to write", async () => {
    const slug = await createProject(owner);

    await request(app)
      .post(`/api/v1/projects/${slug}/milestones`)
      .send({ title: "Anonymous milestone" })
      .expect(401);
  });

  it("404s the roadmap of a private project, exactly as the project does", async () => {
    // The child route must not become a privacy oracle: same status, same
    // shape, whether the project is private or absent.
    const slug = await createProject(owner);
    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({ visibility: "private" })
      .expect(200);

    await request(app)
      .get(`/api/v1/projects/${slug}/milestones`)
      .set(...bearer(outsider.token))
      .expect(404);
  });
});
