import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Comments and polls end to end (PRD §9, decisions J3 and J4).
 *
 * The tombstone and reply-depth rules are the reason this suite talks to a real
 * database: `Comment.parent` cascades only on a *hard* delete, so what happens
 * to a soft-deleted parent's replies is a property of the query, not of the
 * service's intent.
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

const NS = "cmttest";
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

async function createUser(displayName = "Comment Tester"): Promise<TestUser> {
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
    .send({ content: `Cmttest ${String(n)}`, ...body })
    .expect(201);

  return response.body.data.post.id as string;
}

async function comment(
  actor: TestUser,
  postId: string,
  content: string,
  parentCommentId?: string,
): Promise<string> {
  const response = await request(app)
    .post(`/api/v1/posts/${postId}/comments`)
    .set(...bearer(actor.token))
    .send({ content, ...(parentCommentId ? { parentCommentId } : {}) })
    .expect(201);

  return response.body.data.comment.id as string;
}

async function commentsCountOf(postId: string): Promise<number> {
  const row = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
    select: { commentsCount: true },
  });
  return row.commentsCount;
}

let author: TestUser;
let commenter: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  await connectRedis();
  author = await createUser("Thread Author");
  commenter = await createUser("Thread Commenter");
  outsider = await createUser("Thread Outsider");
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

/* ── Creation and counters ──────────────────────────────────────────────── */

describe("Comments", () => {
  it("posts a comment joined with its author", async () => {
    const postId = await createPost(author);

    const response = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "Nice work" })
      .expect(201);

    expect(response.body.data.comment).toMatchObject({
      content: "Nice work",
      authorId: commenter.userId,
      parentCommentId: null,
      isDeleted: false,
      author: { username: commenter.username },
    });
  });

  it("moves commentsCount, counting replies and excluding deletions", async () => {
    // This is exactly how prisma/seed.ts recomputes the counter.
    const postId = await createPost(author);
    expect(await commentsCountOf(postId)).toBe(0);

    const root = await comment(commenter, postId, "Root");
    expect(await commentsCountOf(postId)).toBe(1);

    await comment(author, postId, "A reply", root);
    expect(await commentsCountOf(postId)).toBe(2);

    await request(app)
      .delete(`/api/v1/comments/${root}`)
      .set(...bearer(commenter.token))
      .expect(200);

    expect(await commentsCountOf(postId)).toBe(1);
  });

  it("never lets a client choose the author", async () => {
    const postId = await createPost(author);

    const response = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "real", authorId: outsider.userId })
      .expect(201);

    expect(response.body.data.comment.authorId).toBe(commenter.userId);
  });

  it("cursor-paginates oldest first", async () => {
    const postId = await createPost(author);
    for (const i of [1, 2, 3]) await comment(commenter, postId, `Comment ${String(i)}`);

    const first = await request(app)
      .get(`/api/v1/posts/${postId}/comments`)
      .query({ limit: 2 })
      .expect(200);

    expect(first.body.data.comments).toHaveLength(2);
    expect(first.body.data.comments[0].content).toBe("Comment 1");
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`/api/v1/posts/${postId}/comments`)
      .query({ limit: 2, cursor: first.body.data.nextCursor })
      .expect(200);

    expect(second.body.data.comments).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it("rejects empty and oversized content", async () => {
    const postId = await createPost(author);

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "   " })
      .expect(422);

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "x".repeat(2_001) })
      .expect(422);
  });
});

/* ── Replies (decision J4) ──────────────────────────────────────────────── */

describe("Replies", () => {
  it("lists one level of replies under a comment", async () => {
    const postId = await createPost(author);
    const root = await comment(commenter, postId, "Root");
    await comment(author, postId, "Reply one", root);
    await comment(outsider, postId, "Reply two", root);

    const response = await request(app)
      .get(`/api/v1/comments/${root}/replies`)
      .expect(200);

    expect(response.body.data.comments).toHaveLength(2);
    expect(
      (response.body.data.comments as { parentCommentId: string }[]).every(
        (c) => c.parentCommentId === root,
      ),
    ).toBe(true);
  });

  it("keeps replies out of the top-level list", async () => {
    const postId = await createPost(author);
    const root = await comment(commenter, postId, "Root");
    await comment(author, postId, "A reply", root);

    const response = await request(app)
      .get(`/api/v1/posts/${postId}/comments`)
      .expect(200);

    expect(response.body.data.comments).toHaveLength(1);
    expect(response.body.data.comments[0].replyCount).toBe(1);
  });

  it("rejects a reply to a reply with 422 naming the real parent", async () => {
    const postId = await createPost(author);
    const root = await comment(commenter, postId, "Root");
    const reply = await comment(author, postId, "A reply", root);

    const response = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(outsider.token))
      .send({ content: "Too deep", parentCommentId: reply })
      .expect(422);

    expect(response.body.error.details[0].message).toContain(root);
  });

  it("404s a parent belonging to another post", async () => {
    const postA = await createPost(author);
    const postB = await createPost(author);
    const foreign = await comment(commenter, postA, "Elsewhere");

    await request(app)
      .post(`/api/v1/posts/${postB}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "hijack", parentCommentId: foreign })
      .expect(404);
  });

  it("refuses a reply to a deleted comment", async () => {
    const postId = await createPost(author);
    const root = await comment(commenter, postId, "Doomed");
    await request(app)
      .delete(`/api/v1/comments/${root}`)
      .set(...bearer(commenter.token))
      .expect(200);

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(author.token))
      .send({ content: "too late", parentCommentId: root })
      .expect(422);
  });
});

/* ── Tombstones (decision J4) ───────────────────────────────────────────── */

describe("Tombstones", () => {
  it("keeps a deleted parent that still has replies, stripped of identity", async () => {
    // Dropping it would leave its replies unreachable — `Comment.parent`
    // cascades only on a hard delete.
    const postId = await createPost(author);
    const root = await comment(commenter, postId, "Sensitive text");
    await comment(author, postId, "A reply that must survive", root);

    await request(app)
      .delete(`/api/v1/comments/${root}`)
      .set(...bearer(commenter.token))
      .expect(200);

    const response = await request(app)
      .get(`/api/v1/posts/${postId}/comments`)
      .expect(200);

    expect(response.body.data.comments).toHaveLength(1);
    const tombstone = response.body.data.comments[0] as Record<string, unknown>;

    expect(tombstone["isDeleted"]).toBe(true);
    expect(tombstone["content"]).toBe("[deleted]");
    expect(tombstone["author"]).toBeNull();
    expect(tombstone["authorId"]).toBe("");
    expect(tombstone["likesCount"]).toBe(0);
    expect(tombstone["replyCount"]).toBe(1);

    // The deleted text is gone from the response entirely.
    expect(JSON.stringify(response.body)).not.toContain("Sensitive text");
  });

  it("drops a deleted comment that has no replies", async () => {
    const postId = await createPost(author);
    const lonely = await comment(commenter, postId, "Nobody replied");

    await request(app)
      .delete(`/api/v1/comments/${lonely}`)
      .set(...bearer(commenter.token))
      .expect(200);

    const response = await request(app)
      .get(`/api/v1/posts/${postId}/comments`)
      .expect(200);

    expect(response.body.data.comments).toHaveLength(0);
  });
});

/* ── Editing, deletion, moderation ──────────────────────────────────────── */

describe("Comment editing and moderation", () => {
  it("lets the author edit their own", async () => {
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Typo heer");

    const response = await request(app)
      .patch(`/api/v1/comments/${id}`)
      .set(...bearer(commenter.token))
      .send({ content: "Typo here" })
      .expect(200);

    expect(response.body.data.comment.content).toBe("Typo here");
  });

  it("stops anyone else editing, including the post author", async () => {
    // Moderation removes content; it does not rewrite it in someone's voice.
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Theirs");

    await request(app)
      .patch(`/api/v1/comments/${id}`)
      .set(...bearer(author.token))
      .send({ content: "rewritten" })
      .expect(403);
  });

  it("lets the post author delete a comment on their own post", async () => {
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Cleanup me");

    await request(app)
      .delete(`/api/v1/comments/${id}`)
      .set(...bearer(author.token))
      .expect(200);
  });

  it("stops an unrelated user deleting", async () => {
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Not yours");

    await request(app)
      .delete(`/api/v1/comments/${id}`)
      .set(...bearer(outsider.token))
      .expect(403);
  });
});

/* ── Comment likes ──────────────────────────────────────────────────────── */

describe("Comment likes", () => {
  it("likes, 409s a duplicate, and unlikes idempotently", async () => {
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Likeable");

    const liked = await request(app)
      .post(`/api/v1/comments/${id}/like`)
      .set(...bearer(author.token))
      .expect(201);
    expect(liked.body.data.likesCount).toBe(1);

    await request(app)
      .post(`/api/v1/comments/${id}/like`)
      .set(...bearer(author.token))
      .expect(409);

    for (const _ of [1, 2]) {
      const response = await request(app)
        .delete(`/api/v1/comments/${id}/like`)
        .set(...bearer(author.token))
        .expect(200);
      expect(response.body.data.likesCount).toBe(0);
    }
  });

  it("refuses to like a deleted comment", async () => {
    const postId = await createPost(author);
    const id = await comment(commenter, postId, "Going away");
    await request(app)
      .delete(`/api/v1/comments/${id}`)
      .set(...bearer(commenter.token))
      .expect(200);

    await request(app)
      .post(`/api/v1/comments/${id}/like`)
      .set(...bearer(author.token))
      .expect(404);
  });
});

/* ── Polls ──────────────────────────────────────────────────────────────── */

describe("Poll voting", () => {
  async function pollPost(): Promise<{ postId: string; optionIds: string[] }> {
    const response = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({
        type: "poll",
        content: "Vote please",
        poll: { question: "Which?", options: ["Alpha", "Beta"] },
      })
      .expect(201);

    const post = response.body.data.post as {
      id: string;
      poll: { options: { id: string }[] };
    };
    return { postId: post.id, optionIds: post.poll.options.map((o) => o.id) };
  }

  it("records a vote and moves the tally", async () => {
    const { postId, optionIds } = await pollPost();

    const response = await request(app)
      .post(`/api/v1/posts/${postId}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: optionIds[0] })
      .expect(201);

    expect(response.body.data.votedOptionId).toBe(optionIds[0]);
    const tally = response.body.data.options as { id: string; voteCount: number }[];
    expect(tally.find((o) => o.id === optionIds[0])?.voteCount).toBe(1);
  });

  it("refuses a second vote, even for a different option", async () => {
    // The unique constraint is on the poll, not the option — votes are final,
    // which is what the shipped PollVoter assumes when it disables itself.
    const { postId, optionIds } = await pollPost();

    await request(app)
      .post(`/api/v1/posts/${postId}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: optionIds[0] })
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${postId}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: optionIds[1] })
      .expect(409);
  });

  it("reports the viewer's vote back on the post", async () => {
    const { postId, optionIds } = await pollPost();
    await request(app)
      .post(`/api/v1/posts/${postId}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: optionIds[1] })
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(commenter.token))
      .expect(200);

    expect(response.body.data.post.poll.votedOptionId).toBe(optionIds[1]);
    expect(response.body.data.viewer.votedOptionId).toBe(optionIds[1]);
  });

  it("404s an option belonging to another poll", async () => {
    const a = await pollPost();
    const b = await pollPost();

    await request(app)
      .post(`/api/v1/posts/${a.postId}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: b.optionIds[0] })
      .expect(404);
  });

  it("refuses a vote on a closed poll", async () => {
    const response = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({
        type: "poll",
        content: "Closed already",
        poll: {
          question: "Too late?",
          options: ["Yes", "No"],
          closesAt: new Date(Date.now() - 60_000).toISOString(),
        },
      })
      .expect(201);

    const post = response.body.data.post as {
      id: string;
      poll: { options: { id: string }[]; isClosed: boolean };
    };
    expect(post.poll.isClosed).toBe(true);

    await request(app)
      .post(`/api/v1/posts/${post.id}/poll/vote`)
      .set(...bearer(commenter.token))
      .send({ optionId: post.poll.options[0]?.id })
      .expect(422);
  });
});
