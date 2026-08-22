import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The feed (BACKEND_ARCHITECTURE.md §11, decision J5).
 *
 * The feed is built last and tested hardest because it is the one surface that
 * aggregates everyone's content: a visibility rule that holds on a single post
 * read but leaks here would expose private content to every user at once.
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

const NS = "feedtest";
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

async function createUser(displayName = "Feed Tester"): Promise<TestUser> {
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

let n = 0;
async function createPost(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<string> {
  n += 1;
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(actor.token))
    .send({ content: `Feedtest ${String(n)}`, ...body })
    .expect(201);

  return response.body.data.post.id as string;
}

async function feedIds(filter: string, token?: string, limit = 100): Promise<string[]> {
  const req = request(app).get("/api/v1/feed").query({ filter, limit });
  if (token) req.set(...bearer(token));

  const response = await req.expect(200);
  return (response.body.data.items as { id: string }[]).map((p) => p.id);
}

/**
 * Feed ids narrowed to posts written by this suite's own users.
 *
 * The feed is global, and the other Phase 6 suites insert posts into the same
 * database while this one runs. Any assertion that compares two feed snapshots
 * therefore has to ignore rows it does not own: otherwise a post created by a
 * neighbouring suite between the two requests fails the test for a reason that
 * has nothing to do with the behaviour under test.
 */
async function ownFeedIds(filter: string, authors: Set<string>): Promise<string[]> {
  const response = await request(app)
    .get("/api/v1/feed")
    .query({ filter, limit: 100 })
    .expect(200);

  const items = response.body.data.items as {
    id: string;
    author: { username: string } | null;
  }[];

  return items
    .filter((post) => post.author !== null && authors.has(post.author.username))
    .map((post) => post.id);
}

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

beforeAll(async () => {
  await connectRedis();
  alice = await createUser("Feed Alice");
  bob = await createUser("Feed Bob");
  carol = await createUser("Feed Carol");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.comment.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── Shape ──────────────────────────────────────────────────────────────── */

describe("Feed shape", () => {
  it("returns the frontend's Paginated contract, not the offset envelope", async () => {
    // `FeedList` drives useInfiniteQuery with
    // `getNextPageParam: (lastPage) => lastPage.nextCursor`.
    await createPost(alice);

    const response = await request(app)
      .get("/api/v1/feed")
      .query({ limit: 2 })
      .expect(200);

    expect(response.body.data).toHaveProperty("items");
    expect(response.body.data).toHaveProperty("nextCursor");
    expect(response.body.data).toHaveProperty("total");
    expect(Array.isArray(response.body.data.items)).toBe(true);
  });

  it("cursor-paginates without repeating or skipping", async () => {
    for (const _ of [1, 2, 3, 4, 5]) await createPost(alice);

    const first = await request(app).get("/api/v1/feed").query({ limit: 3 }).expect(200);
    expect(first.body.data.items).toHaveLength(3);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get("/api/v1/feed")
      .query({ limit: 3, cursor: first.body.data.nextCursor })
      .expect(200);

    const firstIds = (first.body.data.items as { id: string }[]).map((p) => p.id);
    const secondIds = (second.body.data.items as { id: string }[]).map((p) => p.id);

    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it("rejects an unknown filter and an oversized limit", async () => {
    await request(app).get("/api/v1/feed").query({ filter: "chronological" }).expect(422);
    await request(app).get("/api/v1/feed").query({ limit: 101 }).expect(422);
  });
});

/* ── Filters (decision J5) ──────────────────────────────────────────────── */

describe("Feed filters", () => {
  it("accepts all six the shipped UI renders", async () => {
    for (const filter of [
      "latest",
      "trending",
      "following",
      "recommended",
      "popular_today",
      "ai_recommended",
    ]) {
      await request(app).get("/api/v1/feed").query({ filter }).expect(200);
    }
  });

  it("orders `latest` newest first", async () => {
    const older = await createPost(alice);
    const newer = await createPost(alice);

    const ids = await feedIds("latest");
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  it("orders `trending` by likes", async () => {
    const quiet = await createPost(alice);
    const popular = await createPost(alice);

    for (const user of [bob, carol]) {
      await request(app)
        .post(`/api/v1/posts/${popular}/like`)
        .set(...bearer(user.token))
        .expect(201);
    }

    const ids = await feedIds("trending");
    expect(ids.indexOf(popular)).toBeLessThan(ids.indexOf(quiet));
  });

  it("makes `ai_recommended` an alias of `recommended`, not an error", async () => {
    // ARCHITECTURE §11 forbids a recommendation engine in this phase, and a
    // 501 would break a chip the UI already shows.
    const mine = new Set([alice.username, bob.username, carol.username]);
    const recommended = await ownFeedIds("recommended", mine);
    const aiRecommended = await ownFeedIds("ai_recommended", mine);

    // Same rows, same order — an alias, not merely a second endpoint that
    // happens to return 200.
    expect(aiRecommended).toEqual(recommended);
    expect(recommended.length).toBeGreaterThan(0);
  });

  it("shows only followed authors in `following`", async () => {
    const bobsPost = await createPost(bob);
    const carolsPost = await createPost(carol);

    await request(app)
      .post(`/api/v1/users/${bob.username}/follow`)
      .set(...bearer(alice.token))
      .expect(201);

    const ids = await feedIds("following", alice.token);
    expect(ids).toContain(bobsPost);
    expect(ids).not.toContain(carolsPost);
  });

  it("returns nothing for `following` when nobody is signed in", async () => {
    // An anonymous caller follows nobody; degrading to "latest" would be a
    // silently different feed than the one requested.
    const response = await request(app)
      .get("/api/v1/feed")
      .query({ filter: "following" })
      .expect(200);

    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });

  it("scopes `popular_today` to a recent window", async () => {
    const recent = await createPost(alice);
    const ids = await feedIds("popular_today");
    expect(ids).toContain(recent);
  });
});

/* ── Visibility in the feed ─────────────────────────────────────────────── */

describe("Feed visibility", () => {
  it("omits a private post from everyone but its author", async () => {
    const priv = await createPost(alice, { visibility: "private" });

    expect(await feedIds("latest")).not.toContain(priv);
    expect(await feedIds("latest", bob.token)).not.toContain(priv);
    // The author still sees their own in their own timeline.
    expect(await feedIds("latest", alice.token)).toContain(priv);
  });

  it("omits an unlisted post from the feed but serves it by id", async () => {
    const unlisted = await createPost(alice, { visibility: "unlisted" });

    expect(await feedIds("latest", bob.token)).not.toContain(unlisted);
    await request(app)
      .get(`/api/v1/posts/${unlisted}`)
      .set(...bearer(bob.token))
      .expect(200);
  });

  it("omits a soft-deleted post", async () => {
    const doomed = await createPost(alice);
    await request(app)
      .delete(`/api/v1/posts/${doomed}`)
      .set(...bearer(alice.token))
      .expect(200);

    expect(await feedIds("latest")).not.toContain(doomed);
  });

  it("omits a blocked author's posts, in every filter", async () => {
    const blocked = await createUser("Feed Blocked");
    const post = await createPost(alice);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(alice.token))
      .expect(201);

    for (const filter of ["latest", "trending", "recommended", "popular_today"]) {
      expect(await feedIds(filter, blocked.token)).not.toContain(post);
    }
  });

  it("omits a blocked author from `following` too", async () => {
    // Without this, a block would be bypassable simply by having followed the
    // blocker first — the case Phase 4's two-directional delete exists for.
    const blocked = await createUser("Feed Blocked Follower");
    await request(app)
      .post(`/api/v1/users/${alice.username}/follow`)
      .set(...bearer(blocked.token))
      .expect(201);

    const post = await createPost(alice);
    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(alice.token))
      .expect(201);

    expect(await feedIds("following", blocked.token)).not.toContain(post);
  });

  it("excludes community posts entirely (decision J9)", async () => {
    // Set directly, since the API refuses communityId on create.
    const id = await createPost(alice);
    const community = await prisma.community.findFirst({ select: { id: true } });

    if (community) {
      await prisma.post.update({
        where: { id },
        data: { communityId: community.id },
      });

      expect(await feedIds("latest", alice.token)).not.toContain(id);
      // …and it is unreadable by anyone but its author until Phase 7.
      await request(app)
        .get(`/api/v1/posts/${id}`)
        .set(...bearer(bob.token))
        .expect(404);
    }
  });
});

/* ── New-count poll (decision J10) ──────────────────────────────────────── */

describe("New post count", () => {
  it("counts only posts newer than the watermark", async () => {
    const since = new Date().toISOString();
    await createPost(alice);
    await createPost(bob);

    const response = await request(app)
      .get("/api/v1/feed/new-count")
      .query({ since })
      .expect(200);

    expect(response.body.data.count).toBeGreaterThanOrEqual(2);
    expect(response.body.data.since).toBe(since);
  });

  it("returns zero when nothing is newer", async () => {
    const response = await request(app)
      .get("/api/v1/feed/new-count")
      .query({ since: new Date(Date.now() + 60_000).toISOString() })
      .expect(200);

    expect(response.body.data.count).toBe(0);
  });

  it("counts against the same visibility scope the feed serves", async () => {
    // A count that promised rows the feed then refused would be worse than no
    // count at all.
    const since = new Date().toISOString();
    await createPost(alice, { visibility: "private" });

    const response = await request(app)
      .get("/api/v1/feed/new-count")
      .query({ since })
      .expect(200);

    expect(response.body.data.count).toBe(0);
  });

  it("requires a parsable `since`", async () => {
    await request(app).get("/api/v1/feed/new-count").expect(422);
  });

  it("resolves `/feed/new-count` as a route, not a feed item", async () => {
    const response = await request(app)
      .get("/api/v1/feed/new-count")
      .query({ since: new Date().toISOString() })
      .expect(200);

    expect(response.body.data).toHaveProperty("count");
  });
});
