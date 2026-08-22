import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Counter correctness under genuine concurrency.
 *
 * Every test fires real simultaneous HTTP requests against real PostgreSQL.
 * The guarantees Phase 6 relies on are properties of unique indexes and row
 * locks, and a mocked Prisma would report that a function was called rather
 * than that a counter survived the race.
 *
 * Note the poll case in particular: `@@unique([pollId, userId])` is on the
 * *poll*, not the option, so two simultaneous votes for two different options
 * are a race the database itself has to settle.
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

const NS = "pconctest";
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

async function createUser(displayName = "Conc Tester"): Promise<TestUser> {
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
    .send({ content: `Pconc ${String(n)}`, ...body })
    .expect(201);

  return response.body.data.post.id as string;
}

async function counters(postId: string) {
  return prisma.post.findUniqueOrThrow({
    where: { id: postId },
    select: { likesCount: true, commentsCount: true },
  });
}

let author: TestUser;
let actors: TestUser[];

beforeAll(async () => {
  await connectRedis();
  author = await createUser("Conc Author");
  actors = await Promise.all(
    Array.from({ length: 6 }, (_, i) => createUser(`Conc Actor ${String(i)}`)),
  );
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

describe("Simultaneous identical likes", () => {
  it("commits exactly one, and moves the counter exactly once", async () => {
    const postId = await createPost(author);
    const liker = actors[0]!;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/api/v1/posts/${postId}/like`)
          .set(...bearer(liker.token)),
      ),
    );

    // The composite primary key is the arbiter: one insert commits, the other
    // seven raise P2002 and roll back — including their counter increments.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);

    const rows = await prisma.postLike.count({ where: { postId } });
    expect(rows).toBe(1);
    expect((await counters(postId)).likesCount).toBe(1);
  });
});

describe("Simultaneous distinct likers", () => {
  it("counts every one, losing no update", async () => {
    const postId = await createPost(author);

    const results = await Promise.all(
      actors.map((actor) =>
        request(app)
          .post(`/api/v1/posts/${postId}/like`)
          .set(...bearer(actor.token)),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await counters(postId)).likesCount).toBe(actors.length);
  });
});

describe("Interleaved likes and unlikes", () => {
  it("never drives the counter negative and matches the row count", async () => {
    const postId = await createPost(author);
    const liker = actors[0]!;

    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(liker.token))
      .expect(201);

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        request(app)
          .delete(`/api/v1/posts/${postId}/like`)
          .set(...bearer(liker.token)),
      ),
      ...Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/posts/${postId}/like`)
          .set(...bearer(liker.token)),
      ),
    ]);

    const final = await counters(postId);
    const rows = await prisma.postLike.count({ where: { postId } });

    expect(final.likesCount).toBeGreaterThanOrEqual(0);
    expect(final.likesCount).toBe(rows);
  });
});

describe("Simultaneous comments", () => {
  it("counts every comment exactly once", async () => {
    const postId = await createPost(author);

    await Promise.all(
      actors.map((actor, i) =>
        request(app)
          .post(`/api/v1/posts/${postId}/comments`)
          .set(...bearer(actor.token))
          .send({ content: `Concurrent ${String(i)}` }),
      ),
    );

    const rows = await prisma.comment.count({ where: { postId, deletedAt: null } });
    expect(rows).toBe(actors.length);
    expect((await counters(postId)).commentsCount).toBe(actors.length);
  });

  it("keeps commentsCount equal to the live row count after deletions", async () => {
    const postId = await createPost(author);

    const ids = await Promise.all(
      actors.slice(0, 4).map(async (actor, i) => {
        const response = await request(app)
          .post(`/api/v1/posts/${postId}/comments`)
          .set(...bearer(actor.token))
          .send({ content: `Doomed ${String(i)}` })
          .expect(201);
        return { id: response.body.data.comment.id as string, actor };
      }),
    );

    await Promise.all(
      ids.slice(0, 2).map(({ id, actor }) =>
        request(app)
          .delete(`/api/v1/comments/${id}`)
          .set(...bearer(actor.token)),
      ),
    );

    const live = await prisma.comment.count({ where: { postId, deletedAt: null } });
    expect((await counters(postId)).commentsCount).toBe(live);
  });
});

describe("Simultaneous bookmarks", () => {
  it("creates one row and refuses the rest with 409", async () => {
    const postId = await createPost(author);
    const actor = actors[1]!;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/v1/posts/${postId}/bookmark`)
          .set(...bearer(actor.token)),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const rows = await prisma.bookmark.count({
      where: { postId, userId: actor.userId },
    });
    expect(rows).toBe(1);
  });
});

describe("Simultaneous poll votes", () => {
  async function pollPost(): Promise<{ postId: string; optionIds: string[] }> {
    const response = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({
        type: "poll",
        content: "Race",
        poll: { question: "Which?", options: ["Alpha", "Beta", "Gamma"] },
      })
      .expect(201);

    const post = response.body.data.post as {
      id: string;
      poll: { id: string; options: { id: string }[] };
    };
    return { postId: post.id, optionIds: post.poll.options.map((o) => o.id) };
  }

  it("records exactly one vote per user, even across different options", async () => {
    // The unique constraint is on (pollId, userId), so two simultaneous votes
    // for two *different* options must still resolve to one. Without the
    // increment inside that transaction, the losing vote would still have
    // inflated a tally.
    const { postId, optionIds } = await pollPost();
    const voter = actors[2]!;

    const results = await Promise.all(
      optionIds.map((optionId) =>
        request(app)
          .post(`/api/v1/posts/${postId}/poll/vote`)
          .set(...bearer(voter.token))
          .send({ optionId }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);

    const votes = await prisma.pollVote.count({
      where: { userId: voter.userId, poll: { postId } },
    });
    expect(votes).toBe(1);

    const tallies = await prisma.pollOption.findMany({
      where: { poll: { postId } },
      select: { voteCount: true },
    });
    const total = tallies.reduce((sum, o) => sum + o.voteCount, 0);

    // The tally total must equal the number of votes actually recorded.
    expect(total).toBe(1);
  });

  it("keeps tallies equal to the vote rows under many distinct voters", async () => {
    const { postId, optionIds } = await pollPost();

    await Promise.all(
      actors.map((actor, i) =>
        request(app)
          .post(`/api/v1/posts/${postId}/poll/vote`)
          .set(...bearer(actor.token))
          .send({ optionId: optionIds[i % optionIds.length] }),
      ),
    );

    const votes = await prisma.pollVote.count({ where: { poll: { postId } } });
    const tallies = await prisma.pollOption.findMany({
      where: { poll: { postId } },
      select: { voteCount: true },
    });
    const total = tallies.reduce((sum, o) => sum + o.voteCount, 0);

    expect(total).toBe(votes);
    expect(votes).toBe(actors.length);
  });
});
