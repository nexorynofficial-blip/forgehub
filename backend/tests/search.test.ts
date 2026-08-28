import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Search over HTTP, end to end (PRD §15, TRD §24, ARCHITECTURE §24, §29).
 *
 * The visibility matrix has its own exhaustive unit suite and the query
 * behaviour has its own repository suite; this file proves the endpoint is
 * actually *wired* — that one route serves all five entities, that the filter
 * and sort allow-lists reach the query, that paging is applied per group, and
 * that the response shape is the grouped contract a client can rely on.
 *
 * Leakage is the subject of `search-security.test.ts`. What is asserted here
 * is the contract; what is asserted there is that the contract cannot be
 * talked out of its rules.
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

const NS = "searchapi";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/search";

/** Unique per run so a concurrent suite cannot match these fixtures. */
const TOKEN = `qzt${String(Date.now() % 1000000)}`;

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

async function createUser(displayName = `${TOKEN} Person`): Promise<TestUser> {
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

interface SearchGroupBody {
  items: { id: string }[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface SearchBody {
  query: string;
  type: string;
  sort: string;
  users: SearchGroupBody;
  projects: SearchGroupBody;
  communities: SearchGroupBody;
  posts: SearchGroupBody;
  tags: SearchGroupBody;
  totalResults: number;
}

/** Runs a search, anonymously unless a token is given. */
async function search(
  query: Record<string, string>,
  token?: string,
): Promise<SearchBody> {
  const call = request(app).get(BASE).query(query);
  if (token !== undefined) call.set(...bearer(token));

  const response = await call.expect(200);
  return response.body.data as SearchBody;
}

function idsOf(group: SearchGroupBody): string[] {
  return group.items.map((item) => item.id);
}

let owner: TestUser;
let projectId = "";
let communityId = "";
let postId = "";
let tagId = "";

beforeAll(async () => {
  await connectRedis();

  owner = await createUser(`${TOKEN} Owner`);

  const project = await request(app)
    .post("/api/v1/projects")
    .set(...bearer(owner.token))
    .send({ title: `${TOKEN} Engine`, description: "A searchable project." })
    .expect(201);
  projectId = project.body.data.project.id as string;

  const community = await request(app)
    .post("/api/v1/communities")
    .set(...bearer(owner.token))
    .send({
      name: `${TOKEN} Guild`,
      description: "A searchable community.",
      category: "Design",
    })
    .expect(201);
  communityId = community.body.data.community.id as string;

  const post = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(owner.token))
    .send({ type: "text", content: `${TOKEN} a searchable post body` })
    .expect(201);
  postId = post.body.data.post.id as string;

  const tag = await prisma.tag.create({
    data: { slug: `${NS}-${TOKEN}-tag`, name: `${TOKEN} Tag` },
    select: { id: true },
  });
  tagId = tag.id;
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

  await prisma.tag.deleteMany({ where: { slug: { startsWith: NS } } });
  await prisma.$disconnect();
  await redis.quit();
});

/* ── The five entities ───────────────────────────────────────────────────── */

describe("GET /search", () => {
  it("searches all five entities from one endpoint", async () => {
    const body = await search({ q: TOKEN });

    expect(idsOf(body.users)).toContain(owner.userId);
    expect(idsOf(body.projects)).toContain(projectId);
    expect(idsOf(body.communities)).toContain(communityId);
    expect(idsOf(body.posts)).toContain(postId);
    expect(idsOf(body.tags)).toContain(tagId);
  });

  it("echoes the normalized query, type, and sort", async () => {
    const body = await search({ q: `  ${TOKEN}  ` });
    expect(body.query).toBe(TOKEN);
    expect(body.type).toBe("all");
    expect(body.sort).toBe("recent");
  });

  it("always returns all five groups, whatever the filter", async () => {
    for (const type of ["all", "users", "projects", "communities", "posts", "tags"]) {
      const body = await search({ q: TOKEN, type });
      for (const group of [
        "users",
        "projects",
        "communities",
        "posts",
        "tags",
      ] as const) {
        expect(body[group], `${type}/${group}`).toBeDefined();
        expect(Array.isArray(body[group].items), `${type}/${group}`).toBe(true);
        expect(body[group].pagination, `${type}/${group}`).toBeDefined();
      }
    }
  });

  it("reports totalResults as the sum of the visible group totals", async () => {
    const body = await search({ q: TOKEN });
    const sum =
      body.users.pagination.total +
      body.projects.pagination.total +
      body.communities.pagination.total +
      body.posts.pagination.total +
      body.tags.pagination.total;

    expect(body.totalResults).toBe(sum);
  });

  it("works for an anonymous caller", async () => {
    // `optionalAuth`, not `requireAuth`: the shipped topbar renders its search
    // input before anyone signs in.
    const body = await search({ q: TOKEN });
    expect(body.totalResults).toBeGreaterThan(0);
  });

  it("is case-insensitive", async () => {
    const lower = await search({ q: TOKEN.toLowerCase() });
    const upper = await search({ q: TOKEN.toUpperCase() });
    expect(idsOf(lower.projects)).toContain(projectId);
    expect(idsOf(upper.projects)).toContain(projectId);
  });
});

/* ── The type filter ─────────────────────────────────────────────────────── */

describe("the type filter", () => {
  it("returns only the requested group, leaving the others empty", async () => {
    const body = await search({ q: TOKEN, type: "projects" });

    expect(idsOf(body.projects)).toContain(projectId);
    expect(body.users.items).toEqual([]);
    expect(body.communities.items).toEqual([]);
    expect(body.posts.items).toEqual([]);
    expect(body.tags.items).toEqual([]);
    expect(body.type).toBe("projects");
  });

  it("reports zero totals for the groups it skipped", async () => {
    // A skipped group is not a group with hidden results — it was never
    // queried, and its total says so rather than reporting a stale count.
    const body = await search({ q: TOKEN, type: "tags" });
    expect(body.users.pagination.total).toBe(0);
    expect(body.users.pagination.totalPages).toBe(0);
    expect(body.tags.pagination.total).toBeGreaterThan(0);
    expect(body.totalResults).toBe(body.tags.pagination.total);
  });

  it("422s an unknown type", async () => {
    for (const type of ["messages", "notifications", "comments", "everything"]) {
      const response = await request(app).get(BASE).query({ q: TOKEN, type }).expect(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

/* ── Sorting ─────────────────────────────────────────────────────────────── */

describe("sorting", () => {
  it("accepts the allow-listed sort keys", async () => {
    for (const sort of ["recent", "popular"]) {
      const body = await search({ q: TOKEN, sort });
      expect(body.sort).toBe(sort);
    }
  });

  it("422s anything else, relevance included", async () => {
    // Ruling D6: there is no relevance score to sort by, and a caller cannot
    // ask for one by name.
    for (const sort of ["relevance", "score", "xp", "createdAt", "id"]) {
      await request(app).get(BASE).query({ q: TOKEN, sort }).expect(422);
    }
  });

  it("orders tags by usage when asked for popular", async () => {
    const stamp = String(Date.now() % 100000);
    const marker = `${NS}pop${stamp}`;
    await prisma.tag.create({
      data: { slug: `${NS}-poplow-${stamp}`, name: `${marker} low`, usageCount: 2 },
    });
    await prisma.tag.create({
      data: { slug: `${NS}-pophigh-${stamp}`, name: `${marker} high`, usageCount: 88 },
    });

    const body = await search({ q: marker, type: "tags", sort: "popular" });
    const first = body.tags.items[0] as unknown as { usageCount: number };
    expect(first.usageCount).toBe(88);
  });
});

/* ── Pagination ──────────────────────────────────────────────────────────── */

describe("pagination", () => {
  it("applies page and limit per group", async () => {
    const body = await search({ q: TOKEN, type: "projects", page: "1", limit: "1" });

    expect(body.projects.items.length).toBeLessThanOrEqual(1);
    expect(body.projects.pagination.page).toBe(1);
    expect(body.projects.pagination.limit).toBe(1);
  });

  it("clamps an oversized limit instead of rejecting it", async () => {
    const body = await search({ q: TOKEN, limit: "100000" });
    expect(body.projects.pagination.limit).toBe(100);
  });

  it("422s a non-positive page or limit", async () => {
    await request(app).get(BASE).query({ q: TOKEN, page: "0" }).expect(422);
    await request(app).get(BASE).query({ q: TOKEN, limit: "0" }).expect(422);
    await request(app).get(BASE).query({ q: TOKEN, page: "-3" }).expect(422);
  });

  it("returns an empty page past the end, still with a truthful total", async () => {
    const body = await search({ q: TOKEN, type: "projects", page: "999" });
    expect(body.projects.items).toEqual([]);
    expect(body.projects.pagination.total).toBeGreaterThan(0);
  });

  it("reports totalPages consistently with total and limit", async () => {
    const body = await search({ q: TOKEN, type: "tags", limit: "1" });
    const { total, totalPages } = body.tags.pagination;
    expect(totalPages).toBe(total === 0 ? 0 : Math.ceil(total / 1));
  });
});

/* ── Query validation ────────────────────────────────────────────────────── */

describe("the query parameter", () => {
  it("422s a missing term", async () => {
    await request(app).get(BASE).expect(422);
  });

  it("422s a whitespace-only term", async () => {
    for (const q of [" ", "   ", "\t"]) {
      await request(app).get(BASE).query({ q }).expect(422);
    }
  });

  it("422s a wildcard-only term", async () => {
    // `%` alone would compile to `ILIKE '%%%'` and enumerate everything the
    // viewer may see — a bulk dump wearing a search's clothes.
    for (const q of ["%", "%%", "_", "%_%"]) {
      await request(app).get(BASE).query({ q }).expect(422);
    }
  });

  it("422s a term beyond the maximum length", async () => {
    await request(app)
      .get(BASE)
      .query({ q: "x".repeat(101) })
      .expect(422);
  });

  it("accepts a single character", async () => {
    await request(app).get(BASE).query({ q: "a" }).expect(200);
  });

  it("returns 200 with empty groups when nothing matches", async () => {
    // Not a 404: the query was understood and ran, and there was nothing to
    // return. A 404 would also make "no results" and "hidden results"
    // distinguishable, which they must not be.
    const body = await search({ q: `nomatch${String(Date.now())}` });

    expect(body.users.items).toEqual([]);
    expect(body.projects.items).toEqual([]);
    expect(body.communities.items).toEqual([]);
    expect(body.posts.items).toEqual([]);
    expect(body.tags.items).toEqual([]);
    expect(body.totalResults).toBe(0);
  });
});

/* ── Response envelope and projection ────────────────────────────────────── */

describe("the response", () => {
  it("uses the standard success envelope", async () => {
    const response = await request(app).get(BASE).query({ q: TOKEN }).expect(200);

    expect(response.body).toMatchObject({ success: true, error: null });
    expect(response.body.message).toBe("Search completed");
    expect(response.body.data).toBeDefined();
  });

  it("projects a user result without email, role, or status", async () => {
    const body = await search({ q: TOKEN, type: "users" });
    const user = body.users.items[0] as unknown as Record<string, unknown>;

    expect(user).toBeDefined();
    expect(Object.keys(user).sort()).toEqual([
      "avatarUrl",
      "bio",
      "builderRank",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("projects a project result with its owner summarized the same way", async () => {
    const body = await search({ q: TOKEN, type: "projects" });
    const project = body.projects.items.find(
      (item) => item.id === projectId,
    ) as unknown as { owner: Record<string, unknown> | null; tags: string[] } | undefined;

    expect(project).toBeDefined();
    expect(project?.owner).not.toBeNull();
    expect(project?.owner).not.toHaveProperty("email");
    expect(project?.owner).not.toHaveProperty("role");
    expect(Array.isArray(project?.tags)).toBe(true);
  });

  it("never returns 403 for an ordinary search", async () => {
    // Search has no forbidden state: content is either discoverable or absent.
    for (const query of [
      { q: TOKEN },
      { q: TOKEN, type: "users" },
      { q: TOKEN, type: "projects" },
      { q: `nomatch${String(Date.now())}` },
    ]) {
      const response = await request(app).get(BASE).query(query);
      expect(response.status, JSON.stringify(query)).not.toBe(403);
    }
  });

  it("gives an authenticated caller the same shape as an anonymous one", async () => {
    const anonymous = await search({ q: TOKEN });
    const authenticated = await search({ q: TOKEN }, owner.token);

    expect(Object.keys(authenticated).sort()).toEqual(Object.keys(anonymous).sort());
  });
});
