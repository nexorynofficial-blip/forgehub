import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Project collaboration end to end (BACKEND_PRD.md §7).
 *
 * The load-bearing property here is decision J8: `Project.ownerId` and the
 * `owner` membership row must never contradict each other. Several of these
 * tests exist purely to prove the API refuses the writes that would separate
 * them.
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

const NS = "memtest";
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

async function createUser(displayName = "Member Tester"): Promise<TestUser> {
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
    .send({ title: `Memtest ${String(titleCounter)} ${String(Date.now())}` })
    .expect(201);

  return {
    slug: response.body.data.project.slug as string,
    id: response.body.data.project.id as string,
  };
}

const addMember = (actor: TestUser, slug: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/projects/${slug}/members`)
    .set(...bearer(actor.token))
    .send(body);

let owner: TestUser;
let collaborator: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Team Owner");
  collaborator = await createUser("Team Collaborator");
  outsider = await createUser("Team Outsider");
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

describe("Listing members", () => {
  it("returns the joined shape the project page renders", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app)
      .get(`/api/v1/projects/${slug}/members`)
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({
      userId: owner.userId,
      role: "owner",
      user: { username: owner.username, displayName: "Team Owner" },
    });
    expect(response.body.pagination.total).toBe(1);
  });

  it("never exposes a member's email through the joined user", async () => {
    const { slug } = await createProject(owner);
    const response = await request(app)
      .get(`/api/v1/projects/${slug}/members`)
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain("@forgehub.test");
  });
});

describe("Adding members", () => {
  it("adds a collaborator and returns them joined", async () => {
    const { slug } = await createProject(owner);

    const response = await addMember(owner, slug, {
      username: collaborator.username,
      role: "collaborator",
    }).expect(201);

    expect(response.body.data.member).toMatchObject({
      userId: collaborator.userId,
      role: "collaborator",
    });
  });

  it("defaults to contributor", async () => {
    const { slug } = await createProject(owner);

    const response = await addMember(owner, slug, {
      username: collaborator.username,
    }).expect(201);

    expect(response.body.data.member.role).toBe("contributor");
  });

  it("409s a duplicate add", async () => {
    const { slug } = await createProject(owner);
    await addMember(owner, slug, { username: collaborator.username }).expect(201);

    const response = await addMember(owner, slug, {
      username: collaborator.username,
    }).expect(409);

    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("404s an unknown username", async () => {
    const { slug } = await createProject(owner);
    await addMember(owner, slug, { username: "nobody.here" }).expect(404);
  });

  it("refuses the three roles the shipped UI cannot label (decision J4)", async () => {
    const { slug } = await createProject(owner);

    for (const role of ["admin", "developer", "designer"]) {
      await addMember(owner, slug, { username: collaborator.username, role }).expect(422);
    }
  });

  it("refuses to assign `owner`, routing to the transfer endpoint (J8)", async () => {
    // Accepting this would create a second owner membership on a project whose
    // `ownerId` still names someone else — exactly the drift J8 forbids.
    const { slug } = await createProject(owner);

    const response = await addMember(owner, slug, {
      username: collaborator.username,
      role: "owner",
    }).expect(422);

    expect(response.body.error.details[0].message).toContain("transfer");
  });

  it("stops a non-member adding anyone", async () => {
    const { slug } = await createProject(owner);

    await addMember(outsider, slug, { username: outsider.username }).expect(403);
  });

  it("stops a contributor adding anyone", async () => {
    const { slug } = await createProject(owner);
    await addMember(owner, slug, {
      username: collaborator.username,
      role: "contributor",
    }).expect(201);

    await addMember(collaborator, slug, { username: outsider.username }).expect(403);
  });
});

describe("Changing a member's role", () => {
  it("promotes a contributor to collaborator", async () => {
    const { slug } = await createProject(owner);
    await addMember(owner, slug, { username: collaborator.username }).expect(201);

    const response = await request(app)
      .patch(`/api/v1/projects/${slug}/members/${collaborator.username}`)
      .set(...bearer(owner.token))
      .send({ role: "collaborator" })
      .expect(200);

    expect(response.body.data.member.role).toBe("collaborator");
  });

  it("refuses to change the owner's own role (J8)", async () => {
    // Demoting the owner would leave `ownerId` pointing at someone the
    // membership table calls a contributor.
    const { slug } = await createProject(owner);

    await request(app)
      .patch(`/api/v1/projects/${slug}/members/${owner.username}`)
      .set(...bearer(owner.token))
      .send({ role: "contributor" })
      .expect(422);
  });

  it("404s a user who is not a member", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .patch(`/api/v1/projects/${slug}/members/${outsider.username}`)
      .set(...bearer(owner.token))
      .send({ role: "collaborator" })
      .expect(404);
  });
});

describe("Removing members and leaving", () => {
  it("lets the owner remove a member", async () => {
    const { slug, id } = await createProject(owner);
    await addMember(owner, slug, { username: collaborator.username }).expect(201);

    await request(app)
      .delete(`/api/v1/projects/${slug}/members/${collaborator.username}`)
      .set(...bearer(owner.token))
      .expect(200);

    const remaining = await prisma.projectMember.count({ where: { projectId: id } });
    expect(remaining).toBe(1);
  });

  it("lets a member remove themselves without manage_members", async () => {
    // Leaving is the same row being deleted; only who may do it differs.
    const { slug } = await createProject(owner);
    await addMember(owner, slug, { username: collaborator.username }).expect(201);

    await request(app)
      .delete(`/api/v1/projects/${slug}/members/${collaborator.username}`)
      .set(...bearer(collaborator.token))
      .expect(200);
  });

  it("stops a member removing someone else", async () => {
    const { slug } = await createProject(owner);
    await addMember(owner, slug, { username: collaborator.username }).expect(201);
    await addMember(owner, slug, { username: outsider.username }).expect(201);

    await request(app)
      .delete(`/api/v1/projects/${slug}/members/${outsider.username}`)
      .set(...bearer(collaborator.token))
      .expect(403);
  });

  it("refuses to let the owner leave their own project (J8)", async () => {
    const { slug } = await createProject(owner);

    const response = await request(app)
      .delete(`/api/v1/projects/${slug}/members/${owner.username}`)
      .set(...bearer(owner.token))
      .expect(422);

    expect(response.body.error.details[0].message).toContain("Transfer ownership");
  });

  it("404s removing a non-member", async () => {
    const { slug } = await createProject(owner);

    await request(app)
      .delete(`/api/v1/projects/${slug}/members/${outsider.username}`)
      .set(...bearer(owner.token))
      .expect(404);
  });
});

describe("Membership grants project access", () => {
  it("lets a member read a private project", async () => {
    const { slug } = await createProject(owner);
    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .send({ visibility: "private" })
      .expect(200);

    // A non-member sees nothing…
    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(collaborator.token))
      .expect(404);

    await addMember(owner, slug, { username: collaborator.username }).expect(201);

    // …and a member sees it, with their role reported back.
    const response = await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(collaborator.token))
      .expect(200);

    expect(response.body.data.viewer).toMatchObject({
      isMember: true,
      role: "contributor",
      isOwner: false,
      canEdit: false,
    });
  });
});
