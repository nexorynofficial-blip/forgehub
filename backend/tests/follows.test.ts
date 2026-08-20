import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The social graph, end to end against real PostgreSQL and Redis.
 *
 * The counter and concurrency tests are the reason this suite talks to a real
 * database rather than a mock: `followersCount` correctness under simultaneous
 * writes is a property of transactions and unique indexes, and a mocked
 * Prisma would assert nothing about it.
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

const NS = "followtest";
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

async function createUser(displayName = "Graph Tester"): Promise<TestUser> {
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

const follow = (actor: TestUser, target: TestUser) =>
  request(app)
    .post(`/api/v1/users/${target.username}/follow`)
    .set(...bearer(actor.token));

const unfollow = (actor: TestUser, target: TestUser) =>
  request(app)
    .delete(`/api/v1/users/${target.username}/follow`)
    .set(...bearer(actor.token));

async function counters(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { followersCount: true, followingCount: true },
  });
}

beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

describe("Follow", () => {
  it("creates the edge and reports the new relationship", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    const response = await follow(actor, target).expect(201);

    expect(response.body.data).toMatchObject({
      following: true,
      followersCount: 1,
    });
    expect(response.body.data.relationship).toMatchObject({
      isFollowing: true,
      isFollowedBy: false,
      isBlocking: false,
    });
  });

  it("moves both counters in the same transaction", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await follow(actor, target).expect(201);

    expect(await counters(target.userId)).toMatchObject({ followersCount: 1 });
    expect(await counters(actor.userId)).toMatchObject({ followingCount: 1 });
  });

  it("rejects following yourself", async () => {
    const user = await createUser();

    const response = await request(app)
      .post(`/api/v1/users/${user.username}/follow`)
      .set(...bearer(user.token))
      .expect(422);

    expect(response.body.error.message).toMatch(/yourself/i);
    expect(await counters(user.userId)).toMatchObject({
      followersCount: 0,
      followingCount: 0,
    });
  });

  it("rejects a duplicate follow with a conflict", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await follow(actor, target).expect(201);
    const duplicate = await follow(actor, target).expect(409);

    expect(duplicate.body.error.code).toBe("CONFLICT");
    // The failed attempt must not have inflated the counter.
    expect(await counters(target.userId)).toMatchObject({ followersCount: 1 });
  });

  it("404s an unknown target", async () => {
    const actor = await createUser();

    await request(app)
      .post(`/api/v1/users/${NS}.ghost/follow`)
      .set(...bearer(actor.token))
      .expect(404);
  });

  it("requires authentication", async () => {
    const target = await createUser();
    await request(app).post(`/api/v1/users/${target.username}/follow`).expect(401);
  });

  it("reports mutual follows from both sides", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);

    await follow(a, b).expect(201);
    const response = await follow(b, a).expect(201);

    expect(response.body.data.relationship).toMatchObject({
      isFollowing: true,
      isFollowedBy: true,
    });
  });
});

describe("Unfollow", () => {
  it("removes the edge and decrements both counters", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await follow(actor, target).expect(201);
    const response = await unfollow(actor, target).expect(200);

    expect(response.body.data).toMatchObject({ following: false, followersCount: 0 });
    expect(await counters(target.userId)).toMatchObject({ followersCount: 0 });
    expect(await counters(actor.userId)).toMatchObject({ followingCount: 0 });
  });

  it("is idempotent and never drives counters negative", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    // DELETE means "ensure absent" — repeating it is not an error.
    await unfollow(actor, target).expect(200);
    await unfollow(actor, target).expect(200);

    expect(await counters(target.userId)).toMatchObject({ followersCount: 0 });
    expect(await counters(actor.userId)).toMatchObject({ followingCount: 0 });
  });

  it("rejects unfollowing yourself", async () => {
    const user = await createUser();

    await request(app)
      .delete(`/api/v1/users/${user.username}/follow`)
      .set(...bearer(user.token))
      .expect(422);
  });
});

describe("Counter correctness under concurrency", () => {
  it("counts every follower exactly once when eight arrive at the same instant", async () => {
    const target = await createUser("Concurrency Target");
    const followers = await Promise.all(
      Array.from({ length: 8 }, () => createUser("Concurrent Follower")),
    );

    // Fired together rather than sequentially: a read-modify-write counter
    // would lose updates here, which is exactly what `{ increment: 1 }`
    // inside the transaction prevents.
    const results = await Promise.all(followers.map((f) => follow(f, target)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(await counters(target.userId)).toMatchObject({ followersCount: 8 });

    const edges = await prisma.follow.count({ where: { followingId: target.userId } });
    expect(edges).toBe(8);
  });

  it("lets exactly one of eight simultaneous duplicate follows win", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => follow(actor, target)),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);

    // The unique index is the arbiter; the losers roll back their increments.
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(7);
    expect(await counters(target.userId)).toMatchObject({ followersCount: 1 });
    expect(await counters(actor.userId)).toMatchObject({ followingCount: 1 });
  });

  it("settles correctly when follows and unfollows interleave", async () => {
    const target = await createUser("Churn Target");
    const followers = await Promise.all(
      Array.from({ length: 6 }, () => createUser("Churn Follower")),
    );

    await Promise.all(followers.map((f) => follow(f, target)));
    // Three of the six leave, concurrently.
    await Promise.all(followers.slice(0, 3).map((f) => unfollow(f, target)));

    expect(await counters(target.userId)).toMatchObject({ followersCount: 3 });
    const edges = await prisma.follow.count({ where: { followingId: target.userId } });
    expect(edges).toBe(3);
  });
});

describe("Followers and following lists", () => {
  it("lists followers as the frontend's FollowerPreview shape", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);
    await follow(actor, target).expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${target.username}/followers`)
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(Object.keys(response.body.data.items[0]).sort()).toEqual([
      "avatarUrl",
      "displayName",
      "id",
      "username",
    ]);
  });

  it("lists following", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);
    await follow(actor, target).expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${actor.username}/following`)
      .expect(200);

    expect(response.body.data.items[0].username).toBe(target.username);
  });

  it("paginates followers with a cursor and no duplicates", async () => {
    const target = await createUser("Paged Target");
    const followers = await Promise.all(
      Array.from({ length: 5 }, () => createUser("Paged Follower")),
    );
    for (const follower of followers) {
      await follow(follower, target).expect(201);
    }

    const first = await request(app)
      .get(`/api/v1/users/${target.username}/followers?limit=2`)
      .expect(200);

    expect(first.body.data.items).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get(
        `/api/v1/users/${target.username}/followers?limit=2&cursor=${String(first.body.data.nextCursor)}`,
      )
      .expect(200);

    expect(second.body.data.items).toHaveLength(2);

    const seen = [...first.body.data.items, ...second.body.data.items].map(
      (item: { id: string }) => item.id,
    );
    expect(new Set(seen).size).toBe(4);
  });

  it("returns a null cursor on the final page", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);
    await follow(actor, target).expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${target.username}/followers?limit=20`)
      .expect(200);

    expect(response.body.data.nextCursor).toBeNull();
  });

  it("caps the page size at the shared pagination maximum", async () => {
    const target = await createUser();

    await request(app)
      .get(`/api/v1/users/${target.username}/followers?limit=500`)
      .expect(422);
  });

  it("404s lists for an unknown user", async () => {
    await request(app).get(`/api/v1/users/${NS}.ghost/followers`).expect(404);
    await request(app).get(`/api/v1/users/${NS}.ghost/following`).expect(404);
  });
});

describe("Blocking", () => {
  it("blocks a user and reports it", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    const response = await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);

    expect(response.body.data).toMatchObject({ blocking: true });
  });

  it("removes follows in BOTH directions, transactionally", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);

    await follow(a, b).expect(201);
    await follow(b, a).expect(201);

    const response = await request(app)
      .post(`/api/v1/users/${b.username}/block`)
      .set(...bearer(a.token))
      .expect(201);

    // Removing only the blocker's own follow would leave the blocked user
    // still receiving their content through the following feed.
    expect(response.body.data.followsRemoved).toBe(2);
    expect(await prisma.follow.count({ where: { followerId: a.userId } })).toBe(0);
    expect(await prisma.follow.count({ where: { followerId: b.userId } })).toBe(0);
  });

  it("keeps counters consistent after a block tears down follows", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);

    await follow(a, b).expect(201);
    await follow(b, a).expect(201);

    await request(app)
      .post(`/api/v1/users/${b.username}/block`)
      .set(...bearer(a.token))
      .expect(201);

    expect(await counters(a.userId)).toEqual({ followersCount: 0, followingCount: 0 });
    expect(await counters(b.userId)).toEqual({ followersCount: 0, followingCount: 0 });
  });

  it("prevents the blocked user from following the blocker", async () => {
    const [blocker, blocked] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(blocker.token))
      .expect(201);

    // 404, not 403 — confirming a block specifically would disclose it.
    await follow(blocked, blocker).expect(404);
  });

  it("prevents the blocker from following the blocked user", async () => {
    const [blocker, blocked] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(blocker.token))
      .expect(201);

    await follow(blocker, blocked).expect(404);
  });

  it("rejects blocking yourself, and blocking twice", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${actor.username}/block`)
      .set(...bearer(actor.token))
      .expect(422);

    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);
    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(409);
  });

  it("records the block in the audit log", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);

    const entry = await prisma.auditLog.findFirst({
      where: { actorId: actor.userId, action: "USER_BLOCKED", targetId: target.userId },
    });
    expect(entry).not.toBeNull();
  });
});

describe("Unblocking", () => {
  it("removes the block and allows following again", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);
    await request(app)
      .delete(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(200);

    await follow(actor, target).expect(201);
  });

  it("does NOT resurrect the follows the block destroyed", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);

    await follow(a, b).expect(201);
    await follow(b, a).expect(201);

    await request(app)
      .post(`/api/v1/users/${b.username}/block`)
      .set(...bearer(a.token))
      .expect(201);
    await request(app)
      .delete(`/api/v1/users/${b.username}/block`)
      .set(...bearer(a.token))
      .expect(200);

    // Silently restoring a relationship the blocker deliberately severed
    // would be a surprising and unwanted side effect.
    expect(await prisma.follow.count({ where: { followerId: a.userId } })).toBe(0);
    expect(await prisma.follow.count({ where: { followerId: b.userId } })).toBe(0);
    expect(await counters(a.userId)).toEqual({ followersCount: 0, followingCount: 0 });
  });

  it("is idempotent", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .delete(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(200);
  });
});

describe("Block list", () => {
  it("lists the caller's blocked users", async () => {
    const [actor, target] = await Promise.all([createUser(), createUser()]);

    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);

    const response = await request(app)
      .get("/api/v1/users/me/blocks")
      .set(...bearer(actor.token))
      .expect(200);

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].username).toBe(target.username);
  });

  it("shows a different user an empty list, not the blocker's", async () => {
    const [actor, target, stranger] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
    ]);

    await request(app)
      .post(`/api/v1/users/${target.username}/block`)
      .set(...bearer(actor.token))
      .expect(201);

    const response = await request(app)
      .get("/api/v1/users/me/blocks")
      .set(...bearer(stranger.token))
      .expect(200);

    expect(response.body.data.items).toHaveLength(0);
  });

  it("requires authentication", async () => {
    await request(app).get("/api/v1/users/me/blocks").expect(401);
  });
});

describe("Relationship endpoint", () => {
  it("reports the four viewer-relative facts", async () => {
    const [a, b] = await Promise.all([createUser(), createUser()]);
    await follow(a, b).expect(201);

    const response = await request(app)
      .get(`/api/v1/users/${b.username}/relationship`)
      .set(...bearer(a.token))
      .expect(200);

    expect(response.body.data.relationship).toEqual({
      isSelf: false,
      isFollowing: true,
      isFollowedBy: false,
      isBlocking: false,
    });
  });

  it("flags self", async () => {
    const user = await createUser();

    const response = await request(app)
      .get(`/api/v1/users/${user.username}/relationship`)
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.relationship.isSelf).toBe(true);
  });
});
