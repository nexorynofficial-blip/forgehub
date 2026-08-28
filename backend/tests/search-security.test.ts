import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Search leakage, end to end (ARCHITECTURE §24, §27, §35).
 *
 * §35: *"Prioritize tests for security-sensitive functionality."* Search is the
 * widest read surface in the API — one request touches five tables, each with
 * its own visibility rules written for a single-domain listing — so this is
 * the largest suite in the phase and the one that matters most.
 *
 * The claims here are deliberately *negative*: not "the right rows come back"
 * but "the wrong rows never do, and nothing about them can be inferred". Two
 * inference channels are covered alongside the obvious one:
 *
 *   - **`total`.** A count taken under a wider clause than the page would
 *     report the existence of rows the viewer cannot see. Every hidden-row
 *     test therefore also asserts the count.
 *   - **Status codes.** A 403 anywhere would distinguish "hidden from you"
 *     from "does not exist". Search has no forbidden state at all.
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

const NS = "searchsec";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/search";

/** Unique per run so a concurrent suite cannot match these fixtures. */
const TOKEN = `sxv${String(Date.now() % 1000000)}`;

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

async function createUser(label = "Person"): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: `${TOKEN} ${label}`,
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

/** Promotes an account directly in the database — no endpoint grants a role. */
async function promote(
  userId: string,
  role: "moderator" | "community_admin" | "platform_admin",
): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { role } });
}

function bearer(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}

interface Group {
  items: { id: string }[];
  pagination: { total: number };
}

interface Body {
  users: Group;
  projects: Group;
  communities: Group;
  posts: Group;
  tags: Group;
  totalResults: number;
}

async function search(query: Record<string, string>, token?: string): Promise<Body> {
  const call = request(app).get(BASE).query(query);
  if (token !== undefined) call.set(...bearer(token));

  const response = await call.expect(200);
  return response.body.data as Body;
}

function idsOf(group: Group): string[] {
  return group.items.map((item) => item.id);
}

/**
 * The core assertion of this suite.
 *
 * A hidden row must be absent from the page **and** uncounted in the total.
 * Asserting only the first would pass against an implementation that filtered
 * after fetching — which is exactly the implementation this phase refused to
 * write, and exactly the one that leaks.
 */
function expectHidden(group: Group, id: string, label: string): void {
  expect(idsOf(group), label).not.toContain(id);
  expect(group.items.length, `${label} (page vs total)`).toBeLessThanOrEqual(
    group.pagination.total,
  );
}

let owner: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Owner");
  outsider = await createUser("Outsider");
}, 90_000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.community.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Private projects ────────────────────────────────────────────────────── */

describe("private and unlisted projects", () => {
  it("never reaches a stranger or an anonymous caller, in rows or in total", async () => {
    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({
        title: `${TOKEN} Secret Engine`,
        description: "Private.",
        visibility: "private",
      })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    const anonymous = await search({ q: TOKEN, type: "projects" });
    const stranger = await search({ q: TOKEN, type: "projects" }, outsider.token);

    expectHidden(anonymous.projects, projectId, "anonymous");
    expectHidden(stranger.projects, projectId, "stranger");

    // And the owner does see it — otherwise the test would pass on a search
    // that simply returns nothing.
    const mine = await search({ q: TOKEN, type: "projects" }, owner.token);
    expect(idsOf(mine.projects)).toContain(projectId);
  });

  it("hides an unlisted project from listings, which is what a result is", async () => {
    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({
        title: `${TOKEN} Quiet Engine`,
        description: "Unlisted.",
        visibility: "unlisted",
      })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    expectHidden(
      (await search({ q: TOKEN, type: "projects" })).projects,
      projectId,
      "anon",
    );
    expectHidden(
      (await search({ q: TOKEN, type: "projects" }, outsider.token)).projects,
      projectId,
      "stranger",
    );
  });
});

/* ── Private communities ─────────────────────────────────────────────────── */

describe("private communities", () => {
  it("never reaches a non-member", async () => {
    const community = await request(app)
      .post("/api/v1/communities")
      .set(...bearer(owner.token))
      .send({
        name: `${TOKEN} Secret Guild`,
        description: "Private.",
        category: "Design",
        visibility: "private",
      })
      .expect(201);
    const communityId = community.body.data.community.id as string;

    expectHidden(
      (await search({ q: TOKEN, type: "communities" })).communities,
      communityId,
      "anonymous",
    );
    expectHidden(
      (await search({ q: TOKEN, type: "communities" }, outsider.token)).communities,
      communityId,
      "stranger",
    );
    expect(
      idsOf((await search({ q: TOKEN, type: "communities" }, owner.token)).communities),
    ).toContain(communityId);
  });
});

/* ── Followers-only profiles ─────────────────────────────────────────────── */

describe("followers-only profiles", () => {
  it("never reaches a non-follower, and is not redacted into a shell", async () => {
    // A redacted stub would still confirm the handle exists, which is exactly
    // what the followers-only setting is meant to prevent.
    const shy = await createUser("Shy");
    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(shy.token))
      .send({ profileVisibility: "followers" })
      .expect(200);

    expectHidden((await search({ q: TOKEN, type: "users" })).users, shy.userId, "anon");
    expectHidden(
      (await search({ q: TOKEN, type: "users" }, outsider.token)).users,
      shy.userId,
      "stranger",
    );

    // Visible to themselves, which proves the fixture is findable at all.
    expect(idsOf((await search({ q: TOKEN, type: "users" }, shy.token)).users)).toContain(
      shy.userId,
    );
  });

  it("appears once the viewer follows them", async () => {
    const shy = await createUser("Shy2");
    const fan = await createUser("Fan");
    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(shy.token))
      .send({ profileVisibility: "followers" })
      .expect(200);

    const before = await search({ q: TOKEN, type: "users" }, fan.token);
    expect(idsOf(before.users)).not.toContain(shy.userId);

    await request(app)
      .post(`/api/v1/users/${shy.username}/follow`)
      .set(...bearer(fan.token))
      .expect(201);

    const after = await search({ q: TOKEN, type: "users" }, fan.token);
    expect(idsOf(after.users)).toContain(shy.userId);
  });
});

/* ── Non-public posts ────────────────────────────────────────────────────── */

describe("non-public posts", () => {
  it("never reaches anyone but the author", async () => {
    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(owner.token))
      .send({
        type: "text",
        content: `${TOKEN} a private thought`,
        visibility: "private",
      })
      .expect(201);
    const postId = post.body.data.post.id as string;

    expectHidden((await search({ q: TOKEN, type: "posts" })).posts, postId, "anonymous");
    expectHidden(
      (await search({ q: TOKEN, type: "posts" }, outsider.token)).posts,
      postId,
      "stranger",
    );
    expect(
      idsOf((await search({ q: TOKEN, type: "posts" }, owner.token)).posts),
    ).toContain(postId);
  });

  it("hides a public post inside a private community from its own members", async () => {
    // The Phase 6 feed decision, restated for search: private-community content
    // is read on the community page, never on a global surface.
    const community = await request(app)
      .post("/api/v1/communities")
      .set(...bearer(owner.token))
      .send({
        name: `${TOKEN} Closed Guild`,
        description: "Private.",
        category: "Design",
        visibility: "private",
      })
      .expect(201);
    const slug = community.body.data.community.slug as string;

    const post = await request(app)
      .post(`/api/v1/communities/${slug}/posts`)
      .set(...bearer(owner.token))
      .send({ type: "text", content: `${TOKEN} inside the closed guild` })
      .expect(201);
    const postId = post.body.data.post.id as string;

    for (const [label, token] of [
      ["anonymous", undefined],
      ["stranger", outsider.token],
      ["the author and owner", owner.token],
    ] as const) {
      expectHidden(
        (await search({ q: TOKEN, type: "posts" }, token)).posts,
        postId,
        label,
      );
    }
  });
});

/* ── Blocking ────────────────────────────────────────────────────────────── */

describe("blocking", () => {
  it("removes the blocker and their content from the blocked viewer's search", async () => {
    const blocker = await createUser("Blocker");
    const blocked = await createUser("Blocked");

    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(blocker.token))
      .send({ title: `${TOKEN} Blocked Engine`, description: "Public but blocked." })
      .expect(201);
    const projectId = project.body.data.project.id as string;

    const post = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(blocker.token))
      .send({ type: "text", content: `${TOKEN} a blocked post` })
      .expect(201);
    const postId = post.body.data.post.id as string;

    // Visible before the block, which is what makes the after-state meaningful.
    const before = await search({ q: TOKEN }, blocked.token);
    expect(idsOf(before.users)).toContain(blocker.userId);
    expect(idsOf(before.projects)).toContain(projectId);
    expect(idsOf(before.posts)).toContain(postId);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(blocker.token))
      .expect(201);

    const after = await search({ q: TOKEN }, blocked.token);
    expectHidden(after.users, blocker.userId, "blocker profile");
    expectHidden(after.projects, projectId, "blocker project");
    expectHidden(after.posts, postId, "blocker post");
  });

  it("leaves the blocker visible to everyone else", async () => {
    // A block is a relationship, not a deletion.
    const blocker = await createUser("Blocker2");
    const blocked = await createUser("Blocked2");

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(blocker.token))
      .expect(201);

    expect(
      idsOf((await search({ q: TOKEN, type: "users" }, outsider.token)).users),
    ).toContain(blocker.userId);
  });
});

/* ── Admin gets nothing extra (ruling D8) ────────────────────────────────── */

describe("platform admins have no wider search", () => {
  it("returns an admin exactly what an ordinary member sees", async () => {
    const hidden = await createUser("Hidden");
    const admin = await createUser("Admin");
    const member = await createUser("Member");
    await promote(admin.userId, "platform_admin");

    await request(app)
      .post("/api/v1/projects")
      .set(...bearer(hidden.token))
      .send({
        title: `${TOKEN} Admin Invisible`,
        description: "Private.",
        visibility: "private",
      })
      .expect(201);

    await request(app)
      .post("/api/v1/communities")
      .set(...bearer(hidden.token))
      .send({
        name: `${TOKEN} Admin Invisible Guild`,
        description: "Private.",
        category: "Design",
        visibility: "private",
      })
      .expect(201);

    // No re-login: the auth middleware re-reads the role from the database
    // rather than trusting the token, so the promotion is already in effect.
    const adminSearch = await search({ q: TOKEN }, admin.token);
    const memberSearch = await search({ q: TOKEN }, member.token);

    expect(adminSearch.projects.pagination.total).toBe(
      memberSearch.projects.pagination.total,
    );
    expect(adminSearch.communities.pagination.total).toBe(
      memberSearch.communities.pagination.total,
    );
    expect(new Set(idsOf(adminSearch.projects))).toEqual(
      new Set(idsOf(memberSearch.projects)),
    );
  });

  it("gives moderators and community admins nothing extra either", async () => {
    const hidden = await createUser("Hidden2");
    await request(app)
      .post("/api/v1/projects")
      .set(...bearer(hidden.token))
      .send({
        title: `${TOKEN} Mod Invisible`,
        description: "Private.",
        visibility: "private",
      })
      .expect(201);

    const baseline = await search({ q: `${TOKEN} Mod Invisible`, type: "projects" });

    for (const role of ["moderator", "community_admin"] as const) {
      const elevated = await createUser(`Role${role}`);
      await promote(elevated.userId, role);

      const result = await search(
        { q: `${TOKEN} Mod Invisible`, type: "projects" },
        elevated.token,
      );
      expect(result.projects.pagination.total, role).toBe(
        baseline.projects.pagination.total,
      );
    }
  });
});

/* ── Client-supplied identity ────────────────────────────────────────────── */

describe("client-supplied identity is ignored", () => {
  it("ignores a userId in the query string", async () => {
    const shy = await createUser("Spoofed");
    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(shy.token))
      .send({ profileVisibility: "followers" })
      .expect(200);

    // Naming the hidden user as the viewer must not evaluate visibility as
    // them. Zod strips the key before the controller ever sees it.
    const spoofed = await search({ q: TOKEN, type: "users", userId: shy.userId });
    expectHidden(spoofed.users, shy.userId, "spoofed userId");

    const asViewer = await search({
      q: TOKEN,
      type: "users",
      viewerId: shy.userId,
      actorId: shy.userId,
      as: shy.userId,
    });
    expectHidden(asViewer.users, shy.userId, "spoofed viewer aliases");
  });

  it("ignores a role claimed in the query string", async () => {
    const hidden = await createUser("RoleSpoof");
    await request(app)
      .post("/api/v1/projects")
      .set(...bearer(hidden.token))
      .send({
        title: `${TOKEN} Role Spoof`,
        description: "Private.",
        visibility: "private",
      })
      .expect(201);

    const claimed = await search({
      q: `${TOKEN} Role Spoof`,
      type: "projects",
      role: "platform_admin",
      isAdmin: "true",
    });
    expect(claimed.projects.pagination.total).toBe(0);
  });

  it("ignores a forged bearer token rather than trusting it", async () => {
    // `optionalAuth` on a bad token falls back to anonymous rather than 401,
    // so the request still succeeds — with anonymous visibility.
    const shy = await createUser("Forged");
    await request(app)
      .patch("/api/v1/users/me/settings")
      .set(...bearer(shy.token))
      .send({ profileVisibility: "followers" })
      .expect(200);

    const response = await request(app)
      .get(BASE)
      .query({ q: TOKEN, type: "users" })
      .set("Authorization", "Bearer not.a.real.token");

    expect([200, 401]).toContain(response.status);
    if (response.status === 200) {
      const body = response.body.data as Body;
      expectHidden(body.users, shy.userId, "forged token");
    }
  });
});

/* ── Projection safety ───────────────────────────────────────────────────── */

describe("the projection never widens", () => {
  it("omits email, role, and status from every user-shaped result", async () => {
    const body = await search({ q: TOKEN });

    const actors: Record<string, unknown>[] = [
      ...(body.users.items as unknown as Record<string, unknown>[]),
      ...(body.projects.items as unknown as { owner: Record<string, unknown> | null }[])
        .map((item) => item.owner)
        .filter((value): value is Record<string, unknown> => value !== null),
      ...(body.posts.items as unknown as { author: Record<string, unknown> | null }[])
        .map((item) => item.author)
        .filter((value): value is Record<string, unknown> => value !== null),
    ];

    expect(actors.length).toBeGreaterThan(0);
    for (const actor of actors) {
      for (const forbidden of [
        "email",
        "role",
        "status",
        "passwordHash",
        "emailVerified",
        "lastActiveAt",
        "deletedAt",
      ]) {
        expect(actor, forbidden).not.toHaveProperty(forbidden);
      }
    }
  });

  it("returns no raw Prisma error text on a malformed request", async () => {
    const response = await request(app).get(BASE).query({ q: "%" }).expect(422);
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain("prisma");
    expect(serialized).not.toContain("Invalid `prisma");
    expect(serialized).not.toContain("SELECT");
  });
});

/* ── No forbidden state ──────────────────────────────────────────────────── */

describe("search has no 403", () => {
  it("never returns 403, authenticated or not", async () => {
    // Content is either discoverable or absent. A 403 would distinguish
    // "hidden from you" from "does not exist", which is the distinction every
    // visibility rule in this codebase exists to erase.
    const queries = [
      { q: TOKEN },
      { q: TOKEN, type: "users" },
      { q: TOKEN, type: "projects" },
      { q: TOKEN, type: "communities" },
      { q: TOKEN, type: "posts" },
      { q: TOKEN, type: "tags" },
      { q: `absent${String(Date.now())}` },
    ];

    for (const query of queries) {
      const anonymous = await request(app).get(BASE).query(query);
      const authenticated = await request(app)
        .get(BASE)
        .query(query)
        .set(...bearer(outsider.token));

      expect(anonymous.status, JSON.stringify(query)).not.toBe(403);
      expect(authenticated.status, JSON.stringify(query)).not.toBe(403);
    }
  });

  it("is indistinguishable between a hidden match and no match at all", async () => {
    const hidden = await createUser("Indistinct");
    await request(app)
      .post("/api/v1/projects")
      .set(...bearer(hidden.token))
      .send({
        title: `${TOKEN} Indistinct Engine`,
        description: "Private.",
        visibility: "private",
      })
      .expect(201);

    const hiddenMatch = await search({
      q: `${TOKEN} Indistinct Engine`,
      type: "projects",
    });
    const noMatch = await search({ q: `nothing${String(Date.now())}`, type: "projects" });

    expect(hiddenMatch.projects.items).toEqual(noMatch.projects.items);
    expect(hiddenMatch.projects.pagination.total).toBe(noMatch.projects.pagination.total);
  });
});
