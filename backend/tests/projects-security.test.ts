import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Phase 5 authorization and privacy matrix.
 *
 * Two properties dominate this suite:
 *
 *   - **Hidden means 404, never 403** — on the project *and* on every child
 *     route. A 403 confirms the project exists, and for a blocked viewer it
 *     announces the block. Any child route that answered differently from its
 *     parent would be a privacy oracle.
 *   - **Nothing leaves the server that the projection layer did not build.**
 *     The repository selects `deletedAt`, and the users repository can reach an
 *     email; neither may appear in a project response.
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

const NS = "psectest";
const PASSWORD = "ValidPass123";

let counter = 0;
function uniqueEmail(): string {
  counter += 1;
  return `${NS}.${String(counter)}.${String(Date.now())}@forgehub.test`;
}

interface TestUser {
  userId: string;
  username: string;
  email: string;
  token: string;
}

async function createUser(displayName = "Security Tester"): Promise<TestUser> {
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
    email,
    token: login.body.data.accessToken as string,
  };
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

/** Promotes a user and re-logs in so the session reflects the new role. */
async function makeAdmin(user: TestUser): Promise<string> {
  await prisma.user.update({
    where: { id: user.userId },
    data: { role: "platform_admin" },
  });

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email: user.email, password: PASSWORD, rememberMe: false })
    .expect(200);

  return login.body.data.accessToken as string;
}

let titleCounter = 0;
async function createProject(
  actor: TestUser,
  visibility?: "public" | "private" | "unlisted",
): Promise<string> {
  titleCounter += 1;
  const response = await request(app)
    .post("/api/v1/projects")
    .set(...bearer(actor.token))
    .send({
      title: `Psectest ${String(titleCounter)} ${String(Date.now())}`,
      ...(visibility !== undefined ? { visibility } : {}),
    })
    .expect(201);

  return response.body.data.project.slug as string;
}

/** Every read route scoped to a single project. */
function childReads(slug: string): string[] {
  return [
    `/api/v1/projects/${slug}`,
    `/api/v1/projects/${slug}/members`,
    `/api/v1/projects/${slug}/milestones`,
    `/api/v1/projects/${slug}/updates`,
  ];
}

let owner: TestUser;
let outsider: TestUser;
let admin: TestUser;
let adminToken: string;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Security Owner");
  outsider = await createUser("Security Outsider");
  admin = await createUser("Security Admin");
  adminToken = await makeAdmin(admin);
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

/* ── Private visibility ─────────────────────────────────────────────────── */

describe("Private projects", () => {
  it("404s every read route for an outsider, never 403", async () => {
    const slug = await createProject(owner, "private");

    for (const path of childReads(slug)) {
      const response = await request(app)
        .get(path)
        .set(...bearer(outsider.token))
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("404s every read route for an anonymous visitor", async () => {
    const slug = await createProject(owner, "private");

    for (const path of childReads(slug)) {
      await request(app).get(path).expect(404);
    }
  });

  it("stays out of the public listing", async () => {
    const slug = await createProject(owner, "private");

    const response = await request(app)
      .get("/api/v1/projects")
      .query({ limit: 100 })
      .expect(200);

    const slugs = (response.body.data as { slug: string }[]).map((p) => p.slug);
    expect(slugs).not.toContain(slug);
  });

  it("stays out of the owner listing for an outsider but not for the owner", async () => {
    const slug = await createProject(owner, "private");

    const anonymous = await request(app)
      .get(`/api/v1/users/${owner.username}/projects`)
      .query({ limit: 100 })
      .expect(200);
    expect((anonymous.body.data as { slug: string }[]).map((p) => p.slug)).not.toContain(
      slug,
    );

    // For the owner it is not hidden content — it is their content.
    const own = await request(app)
      .get(`/api/v1/users/${owner.username}/projects`)
      .query({ limit: 100 })
      .set(...bearer(owner.token))
      .expect(200);
    expect((own.body.data as { slug: string }[]).map((p) => p.slug)).toContain(slug);
  });

  it("rejects every write route from an outsider", async () => {
    const slug = await createProject(owner, "private");

    // 404 rather than 403: the outsider cannot see the project at all, so the
    // gate closes before authorization is ever consulted.
    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(outsider.token))
      .send({ title: "Hostile" })
      .expect(404);

    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(outsider.token))
      .expect(404);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(outsider.token))
      .send({ content: "Hostile" })
      .expect(404);
  });
});

/* ── Unlisted visibility (PRD §6) ───────────────────────────────────────── */

describe("Unlisted projects", () => {
  it("is readable by direct slug", async () => {
    // "Not enumerable" is not "not readable" — that is the whole distinction
    // PRD §6 draws between `unlisted` and `private`.
    const slug = await createProject(owner, "unlisted");

    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(outsider.token))
      .expect(200);

    await request(app).get(`/api/v1/projects/${slug}`).expect(200);
  });

  it("is absent from the discovery listing", async () => {
    const slug = await createProject(owner, "unlisted");

    const response = await request(app)
      .get("/api/v1/projects")
      .query({ limit: 100 })
      .expect(200);

    expect((response.body.data as { slug: string }[]).map((p) => p.slug)).not.toContain(
      slug,
    );
  });

  it("is absent from trending", async () => {
    const slug = await createProject(owner, "unlisted");

    const response = await request(app)
      .get("/api/v1/projects/trending")
      .query({ limit: 50 })
      .expect(200);

    expect(
      (response.body.data.projects as { slug: string }[]).map((p) => p.slug),
    ).not.toContain(slug);
  });
});

/* ── Blocking (decision J5) ─────────────────────────────────────────────── */

describe("Blocking hides projects", () => {
  it("404s the blocker's project for the blocked viewer, on every route", async () => {
    const blocked = await createUser("Blocked Viewer");
    const slug = await createProject(owner, "public");

    // Readable before the block…
    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(blocked.token))
      .expect(200);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    // …and gone afterwards, with the same 404 an absent project gives.
    for (const path of childReads(slug)) {
      await request(app)
        .get(path)
        .set(...bearer(blocked.token))
        .expect(404);
    }
  });

  it("removes the blocker's projects from the blocked viewer's listings", async () => {
    const blocked = await createUser("Blocked Lister");
    const slug = await createProject(owner, "public");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    const listing = await request(app)
      .get("/api/v1/projects")
      .query({ limit: 100 })
      .set(...bearer(blocked.token))
      .expect(200);

    expect((listing.body.data as { slug: string }[]).map((p) => p.slug)).not.toContain(
      slug,
    );
  });

  it("404s the blocker's owner-listing for the blocked viewer", async () => {
    const blocked = await createUser("Blocked Profile Reader");
    await createProject(owner, "public");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    // The same 404 the profile itself gives — not an empty array, which would
    // confirm the account exists.
    await request(app)
      .get(`/api/v1/users/${owner.username}/projects`)
      .set(...bearer(blocked.token))
      .expect(404);
  });

  it("stops the blocked viewer liking, following, or viewing", async () => {
    const blocked = await createUser("Blocked Engager");
    const slug = await createProject(owner, "public");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    for (const path of ["like", "follow", "view"]) {
      await request(app)
        .post(`/api/v1/projects/${slug}/${path}`)
        .set(...bearer(blocked.token))
        .expect(404);
    }
  });

  it("outranks the admin role, exactly as Phase 4 established", async () => {
    // Admin moderation tooling is a Phase 11 surface with its own audited
    // endpoints; it must not arrive by accident through a project read.
    const blockedAdmin = await createUser("Blocked Admin");
    const token = await makeAdmin(blockedAdmin);
    const slug = await createProject(owner, "public");

    await request(app)
      .post(`/api/v1/users/${blockedAdmin.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(token))
      .expect(404);
  });

  it("does not hide the blocked user's own projects from the blocker", async () => {
    // The rule is directional: being blocked hides the *blocker's* projects,
    // not the blocked user's.
    const blocked = await createUser("Blocked Author");
    const slug = await createProject(blocked, "public");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);
  });
});

/* ── Admin override ─────────────────────────────────────────────────────── */

describe("Admin override", () => {
  it("reads a private project", async () => {
    const slug = await createProject(owner, "private");

    await request(app)
      .get(`/api/v1/projects/${slug}`)
      .set(...bearer(adminToken))
      .expect(200);
  });

  it("may edit and delete, but never transfer ownership", async () => {
    const slug = await createProject(owner, "public");

    await request(app)
      .patch(`/api/v1/projects/${slug}`)
      .set(...bearer(adminToken))
      .send({ title: "Moderated Title" })
      .expect(200);

    // Reassigning someone's project is a moderation action, and moderation is
    // a Phase 11 surface with its own audit requirements.
    await request(app)
      .post(`/api/v1/projects/${slug}/transfer`)
      .set(...bearer(adminToken))
      .send({ username: admin.username })
      .expect(403);

    await request(app)
      .delete(`/api/v1/projects/${slug}`)
      .set(...bearer(adminToken))
      .expect(200);
  });
});

/* ── Authentication ─────────────────────────────────────────────────────── */

describe("Anonymous writes", () => {
  it("401s every mutating route", async () => {
    const slug = await createProject(owner, "public");

    const cases: [string, string][] = [
      ["post", "/api/v1/projects"],
      ["patch", `/api/v1/projects/${slug}`],
      ["delete", `/api/v1/projects/${slug}`],
      ["post", `/api/v1/projects/${slug}/transfer`],
      ["post", `/api/v1/projects/${slug}/members`],
      ["post", `/api/v1/projects/${slug}/milestones`],
      ["post", `/api/v1/projects/${slug}/updates`],
      ["post", `/api/v1/projects/${slug}/like`],
      ["delete", `/api/v1/projects/${slug}/like`],
      ["post", `/api/v1/projects/${slug}/follow`],
      ["delete", `/api/v1/projects/${slug}/follow`],
    ];

    for (const [method, path] of cases) {
      const agent = request(app) as unknown as Record<
        string,
        (p: string) => request.Test
      >;
      const call = agent[method];
      if (!call) throw new Error(`unsupported method ${method}`);

      await call.call(request(app), path).send({}).expect(401);
    }
  });
});

/* ── Projection integrity ───────────────────────────────────────────────── */

describe("Response projection", () => {
  it("never exposes a credential column or a soft-delete marker", async () => {
    const slug = await createProject(owner, "public");
    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "Content" })
      .expect(201);

    for (const path of childReads(slug)) {
      const response = await request(app)
        .get(path)
        .set(...bearer(owner.token))
        .expect(200);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("deletedAt");
      expect(body).not.toContain("@forgehub.test");
    }
  });

  it("serves the owner through the shared user summary, not a raw row", async () => {
    const slug = await createProject(owner, "public");

    const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);
    const ownerView = response.body.data.project.owner as Record<string, unknown>;

    expect(Object.keys(ownerView).sort()).toEqual([
      "avatarUrl",
      "builderRank",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("emits metrics nested and never as flat counters", async () => {
    const slug = await createProject(owner, "public");
    const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);
    const project = response.body.data.project as Record<string, unknown>;

    expect(project["metrics"]).toEqual({ views: 0, likes: 0, followers: 0 });
    expect(project).not.toHaveProperty("viewsCount");
    expect(project).not.toHaveProperty("likesCount");
    expect(project).not.toHaveProperty("followersCount");
  });

  it("carries the standard envelope on every project response", async () => {
    const slug = await createProject(owner, "public");

    const single = await request(app).get(`/api/v1/projects/${slug}`).expect(200);
    expect(single.body).toMatchObject({ success: true, error: null });
    expect(typeof single.body.message).toBe("string");

    // TRD §8 forbids returning a large collection unpaginated.
    const listed = await request(app).get("/api/v1/projects").expect(200);
    expect(listed.body.pagination).toMatchObject({
      page: expect.any(Number),
      limit: expect.any(Number),
      total: expect.any(Number),
      totalPages: expect.any(Number),
    });
  });

  it("reports a persisted role verbatim, including one the UI cannot label", async () => {
    // Decision J4: writes are narrowed to three roles, reads are not. The seed
    // already persists `developer`, and misreporting it would be lying about
    // authorization state.
    const slug = await createProject(owner, "public");
    const project = await prisma.project.findUniqueOrThrow({
      where: { slug },
      select: { id: true },
    });

    await prisma.projectMember.create({
      data: { projectId: project.id, userId: outsider.userId, role: "developer" },
    });

    const response = await request(app).get(`/api/v1/projects/${slug}`).expect(200);
    const roles = (response.body.data.project.members as { role: string }[]).map(
      (m) => m.role,
    );

    expect(roles).toContain("developer");
  });
});

/* ── OpenAPI synchronization ────────────────────────────────────────────── */

describe("OpenAPI synchronization", () => {
  it("documents every project route the router mounts", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const paths = Object.keys(response.body.paths as Record<string, unknown>);

    expect(paths).toEqual(
      expect.arrayContaining([
        "/projects",
        "/projects/trending",
        "/projects/{slug}",
        "/projects/{slug}/transfer",
        "/projects/{slug}/members",
        "/projects/{slug}/members/{username}",
        "/projects/{slug}/milestones",
        "/projects/{slug}/milestones/{id}",
        "/projects/{slug}/updates",
        "/projects/{slug}/updates/{id}",
        "/projects/{slug}/like",
        "/projects/{slug}/follow",
        "/projects/{slug}/view",
        "/users/{username}/projects",
      ]),
    );
  });

  it("documents the Project schema as exactly the frontend's contract", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const required = response.body.components.schemas.Project.required as string[];

    // The 20 keys `src/types/project.ts` declares — no more, no fewer. The
    // additive `visibility` and `owner` are documented but not required.
    expect([...required].sort()).toEqual([
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
    ]);
  });

  it("resolves every $ref in the document", async () => {
    // A dangling `$ref` is invisible to `tsc` — it is just a string — so it
    // can only be caught structurally. This found a real one: `UserSummary`
    // was referenced by the project schemas before it existed.
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const document = response.body as Record<string, unknown>;
    const defined = new Set(
      Object.keys(
        (document["components"] as { schemas: Record<string, unknown> }).schemas,
      ),
    );

    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;

      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") refs.push(value);
        else walk(value);
      }
    };
    walk(document);

    const dangling = refs.filter(
      (ref) => !defined.has(ref.replace("#/components/schemas/", "")),
    );

    expect(refs.length).toBeGreaterThan(0);
    expect(dangling).toEqual([]);
  });

  it("documents metrics as nested, matching what the endpoints emit", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const metrics = response.body.components.schemas.ProjectMetrics as {
      required: string[];
    };

    expect([...metrics.required].sort()).toEqual(["followers", "likes", "views"]);
  });
});
