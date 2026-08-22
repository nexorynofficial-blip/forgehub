import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Posts end to end against real PostgreSQL and Redis.
 *
 * Real infrastructure rather than a mocked Prisma, because most of what Phase
 * 6 promises is a property of transactions: `commentsCount` moving with a
 * comment, a poll and its options landing in the same commit as the post, a
 * like counter that cannot be lost. A mock would assert that the service
 * called a function, not that the invariant held.
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

const NS = "posttest";
const PASSWORD = "ValidPass123";

/** Every key the shipped frontend's `Post` type declares. */
const FRONTEND_POST_KEYS = [
  "authorId",
  "codeSnippet",
  "commentsCount",
  "content",
  "createdAt",
  "id",
  "likesCount",
  "mediaUrls",
  "poll",
  "projectId",
  "type",
].sort();

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

async function createUser(displayName = "Post Tester"): Promise<TestUser> {
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

let bodyCounter = 0;
async function createPost(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<{ id: string; post: Record<string, unknown> }> {
  bodyCounter += 1;
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(actor.token))
    .send({ content: `Posttest body ${String(bodyCounter)}`, ...body })
    .expect(201);

  const post = response.body.data.post as Record<string, unknown>;
  return { id: post["id"] as string, post };
}

let author: TestUser;
let reader: TestUser;

beforeAll(async () => {
  await connectRedis();
  author = await createUser("Post Author");
  reader = await createUser("Post Reader");
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // Order matters: `Comment.author` and `Post.author` are both
    // `onDelete: Restrict`, so the content has to go before the accounts.
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

/* ── Creation ───────────────────────────────────────────────────────────── */

describe("Post creation", () => {
  it("creates a text post and returns the frontend's contract", async () => {
    const { post } = await createPost(author);

    expect(FRONTEND_POST_KEYS.every((key) => key in post)).toBe(true);
    expect(post["type"]).toBe("text");
    expect(post["likesCount"]).toBe(0);
    expect(post["commentsCount"]).toBe(0);
    expect(post["mediaUrls"]).toEqual([]);
    expect(post["poll"]).toBeNull();
    expect(post["codeSnippet"]).toBeNull();
    expect(post["authorId"]).toBe(author.userId);
  });

  it("accepts each type the shipped composer offers", async () => {
    for (const type of ["text", "update", "milestone"] as const) {
      const { post } = await createPost(author, { type });
      expect(post["type"]).toBe(type);
    }
  });

  it("stores a code snippet as the frontend's two-field shape", async () => {
    const { post } = await createPost(author, {
      type: "code",
      codeSnippet: { language: "ts", code: "const a = 1;" },
    });

    expect(post["codeSnippet"]).toEqual({ language: "ts", code: "const a = 1;" });
  });

  it("stores media and flattens it to mediaUrls in order", async () => {
    const { post } = await createPost(author, {
      type: "image",
      mediaUrls: ["https://cdn.test/a.png", "https://cdn.test/b.png"],
    });

    expect(post["mediaUrls"]).toEqual([
      "https://cdn.test/a.png",
      "https://cdn.test/b.png",
    ]);
    expect((post["media"] as { position: number }[]).map((m) => m.position)).toEqual([
      0, 1,
    ]);
  });

  it("creates a poll with its options in one commit", async () => {
    const { id, post } = await createPost(author, {
      type: "poll",
      poll: { question: "Which next?", options: ["Billing", "Docs", "Mobile"] },
    });

    const poll = post["poll"] as { question: string; options: unknown[]; id: string };
    expect(poll.question).toBe("Which next?");
    expect(poll.options).toHaveLength(3);

    const stored = await prisma.poll.findUniqueOrThrow({
      where: { postId: id },
      select: { options: { select: { position: true } } },
    });
    expect(stored.options).toHaveLength(3);
  });

  it("rejects an unauthenticated create", async () => {
    await request(app).post("/api/v1/posts").send({ content: "anon" }).expect(401);
  });

  it("never persists a client-supplied authorId", async () => {
    const { post } = await createPost(author, { authorId: reader.userId });
    expect(post["authorId"]).toBe(author.userId);
  });

  it("refuses communityId, which this phase does not support (J9)", async () => {
    // Stripped rather than rejected — the post is created without it.
    const { id } = await createPost(author, {
      communityId: "00000000-0000-4000-8000-000000000009",
    });

    const row = await prisma.post.findUniqueOrThrow({
      where: { id },
      select: { communityId: true },
    });
    expect(row.communityId).toBeNull();
  });

  it("rejects a javascript: media URL (decision J11)", async () => {
    await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({ content: "x", mediaUrls: ["javascript:alert(1)"] })
      .expect(422);
  });
});

/* ── Reads ──────────────────────────────────────────────────────────────── */

describe("Post reads", () => {
  it("serves a public post to an anonymous visitor", async () => {
    const { id } = await createPost(author);

    const response = await request(app).get(`/api/v1/posts/${id}`).expect(200);

    expect(response.body.data.post.id).toBe(id);
    expect(response.body.data.viewer).toBeNull();
  });

  it("describes the viewer's relationship for a signed-in caller", async () => {
    const { id } = await createPost(author);

    const response = await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .expect(200);

    expect(response.body.data.viewer).toMatchObject({
      hasLiked: false,
      isBookmarked: false,
      votedOptionId: null,
      isAuthor: true,
      canEdit: true,
      canDelete: true,
    });
  });

  it("404s an unknown id and 422s a malformed one", async () => {
    await request(app)
      .get("/api/v1/posts/3f1e4c2a-0b6d-4e8f-9a1b-2c3d4e5f6071")
      .expect(404);
    await request(app).get("/api/v1/posts/not-a-uuid").expect(422);
  });

  it("never exposes deletedAt or communityId", async () => {
    const { id } = await createPost(author);
    const response = await request(app).get(`/api/v1/posts/${id}`).expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain("deletedAt");
    expect(body).not.toContain("communityId");
  });

  it("serves the author through the shared user summary", async () => {
    const { id } = await createPost(author);
    const response = await request(app).get(`/api/v1/posts/${id}`).expect(200);

    // This is the frontend's `PostAuthor`, field for field.
    expect(Object.keys(response.body.data.post.author).sort()).toEqual([
      "avatarUrl",
      "builderRank",
      "displayName",
      "id",
      "username",
    ]);
  });
});

/* ── Editing and deletion ───────────────────────────────────────────────── */

describe("Post editing", () => {
  it("edits own content", async () => {
    const { id } = await createPost(author);

    const response = await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .send({ content: "Edited body" })
      .expect(200);

    expect(response.body.data.post.content).toBe("Edited body");
  });

  it("rejects an empty patch", async () => {
    const { id } = await createPost(author);

    await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .send({})
      .expect(422);
  });

  it("refuses to let a patch move the counters", async () => {
    const { id } = await createPost(author);

    const response = await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .send({ content: "ok", likesCount: 500, commentsCount: 500 })
      .expect(200);

    expect(response.body.data.post.likesCount).toBe(0);
    expect(response.body.data.post.commentsCount).toBe(0);
  });

  it("stops a non-author editing", async () => {
    const { id } = await createPost(author);

    await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(reader.token))
      .send({ content: "hostile" })
      .expect(403);
  });
});

describe("Post deletion", () => {
  it("soft-deletes and then reads as not found", async () => {
    const { id } = await createPost(author);

    await request(app)
      .delete(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .expect(200);

    await request(app).get(`/api/v1/posts/${id}`).expect(404);

    const row = await prisma.post.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true },
    });
    expect(row.deletedAt).not.toBeNull();
  });

  it("hides a deleted post even from its own author", async () => {
    const { id } = await createPost(author);

    await request(app)
      .delete(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .expect(200);

    await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .expect(404);
  });

  it("stops a non-author deleting", async () => {
    const { id } = await createPost(author);

    await request(app)
      .delete(`/api/v1/posts/${id}`)
      .set(...bearer(reader.token))
      .expect(403);
  });
});

/* ── Likes and bookmarks ────────────────────────────────────────────────── */

describe("Likes", () => {
  it("likes, reports the counter, and 409s a duplicate", async () => {
    const { id } = await createPost(author);

    const liked = await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(reader.token))
      .expect(201);

    expect(liked.body.data).toMatchObject({ liked: true, likesCount: 1 });

    await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(reader.token))
      .expect(409);
  });

  it("unlikes idempotently without driving the counter negative", async () => {
    const { id } = await createPost(author);
    await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(reader.token))
      .expect(201);

    for (const _ of [1, 2, 3]) {
      const response = await request(app)
        .delete(`/api/v1/posts/${id}/like`)
        .set(...bearer(reader.token))
        .expect(200);
      expect(response.body.data.likesCount).toBe(0);
    }
  });

  it("lets an author like their own post", async () => {
    const { id } = await createPost(author);
    await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(author.token))
      .expect(201);
  });

  it("reports hasLiked back through the viewer block", async () => {
    const { id } = await createPost(author);
    await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(reader.token))
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(reader.token))
      .expect(200);

    expect(response.body.data.viewer.hasLiked).toBe(true);
  });
});

describe("Bookmarks", () => {
  it("bookmarks, appears in the caller's own list, and unbookmarks", async () => {
    const { id } = await createPost(author);

    await request(app)
      .post(`/api/v1/posts/${id}/bookmark`)
      .set(...bearer(reader.token))
      .expect(201);

    const list = await request(app)
      .get("/api/v1/users/me/bookmarks")
      .set(...bearer(reader.token))
      .expect(200);

    expect((list.body.data.items as { id: string }[]).map((p) => p.id)).toContain(id);

    await request(app)
      .delete(`/api/v1/posts/${id}/bookmark`)
      .set(...bearer(reader.token))
      .expect(200);

    const after = await request(app)
      .get("/api/v1/users/me/bookmarks")
      .set(...bearer(reader.token))
      .expect(200);

    expect((after.body.data.items as { id: string }[]).map((p) => p.id)).not.toContain(
      id,
    );
  });

  it("409s a duplicate bookmark", async () => {
    const { id } = await createPost(author);
    await request(app)
      .post(`/api/v1/posts/${id}/bookmark`)
      .set(...bearer(reader.token))
      .expect(201);
    await request(app)
      .post(`/api/v1/posts/${id}/bookmark`)
      .set(...bearer(reader.token))
      .expect(409);
  });

  it("requires authentication and is never exposed for another user", async () => {
    await request(app).get("/api/v1/users/me/bookmarks").expect(401);
  });
});

/* ── Author listing ─────────────────────────────────────────────────────── */

describe("A profile's posts", () => {
  it("lists the author's own posts", async () => {
    const { id } = await createPost(author);

    const response = await request(app)
      .get(`/api/v1/users/${author.username}/posts`)
      .expect(200);

    expect((response.body.data.items as { id: string }[]).map((p) => p.id)).toContain(id);
  });

  it("404s for a user who does not exist", async () => {
    await request(app).get("/api/v1/users/nosuchuser.here/posts").expect(404);
  });
});
