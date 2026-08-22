import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The Phase 6 authorization and privacy matrix.
 *
 * Two properties dominate:
 *
 *   - **Hidden means 404, never 403** — on the post *and* on every child route.
 *     A 403 confirms the post exists, and for a blocked viewer it announces the
 *     block. A child route answering differently from its parent is an oracle.
 *   - **Nothing leaves the server that the projection layer did not build.**
 *     The repository selects `deletedAt` and `communityId`; neither may appear.
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

const NS = "psecpost";
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

async function createUser(displayName = "Sec Tester"): Promise<TestUser> {
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

let n = 0;
async function createPost(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<string> {
  n += 1;
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(actor.token))
    .send({ content: `Psec ${String(n)}`, ...body })
    .expect(201);

  return response.body.data.post.id as string;
}

/** Every read route scoped to a single post. */
function childReads(id: string): string[] {
  return [`/api/v1/posts/${id}`, `/api/v1/posts/${id}/comments`];
}

let author: TestUser;
let outsider: TestUser;
let admin: TestUser;
let adminToken: string;

beforeAll(async () => {
  await connectRedis();
  author = await createUser("Sec Author");
  outsider = await createUser("Sec Outsider");
  admin = await createUser("Sec Admin");
  adminToken = await makeAdmin(admin);
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

/* ── Private posts ──────────────────────────────────────────────────────── */

describe("Private posts", () => {
  it("404s every read route for an outsider, never 403", async () => {
    const id = await createPost(author, { visibility: "private" });

    for (const path of childReads(id)) {
      const response = await request(app)
        .get(path)
        .set(...bearer(outsider.token))
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("404s every read route for an anonymous visitor", async () => {
    const id = await createPost(author, { visibility: "private" });
    for (const path of childReads(id)) await request(app).get(path).expect(404);
  });

  it("rejects every write route from an outsider with 404, not 403", async () => {
    // The outsider cannot see the post at all, so the gate closes before
    // authorization is ever consulted.
    const id = await createPost(author, { visibility: "private" });

    await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(outsider.token))
      .send({ content: "hostile" })
      .expect(404);

    await request(app)
      .post(`/api/v1/posts/${id}/like`)
      .set(...bearer(outsider.token))
      .expect(404);

    await request(app)
      .post(`/api/v1/posts/${id}/bookmark`)
      .set(...bearer(outsider.token))
      .expect(404);

    await request(app)
      .post(`/api/v1/posts/${id}/comments`)
      .set(...bearer(outsider.token))
      .send({ content: "hostile" })
      .expect(404);
  });
});

/* ── Blocking ───────────────────────────────────────────────────────────── */

describe("Blocking hides posts", () => {
  it("404s the blocker's post for the blocked viewer, on every route", async () => {
    const blocked = await createUser("Sec Blocked");
    const id = await createPost(author);

    await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(blocked.token))
      .expect(200);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(author.token))
      .expect(201);

    for (const path of childReads(id)) {
      await request(app)
        .get(path)
        .set(...bearer(blocked.token))
        .expect(404);
    }
  });

  it("outranks the admin role, exactly as Phases 4 and 5 established", async () => {
    const blockedAdmin = await createUser("Sec Blocked Admin");
    const token = await makeAdmin(blockedAdmin);
    const id = await createPost(author);

    await request(app)
      .post(`/api/v1/users/${blockedAdmin.username}/block`)
      .set(...bearer(author.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(token))
      .expect(404);
  });

  it("404s the blocker's post listing for the blocked viewer", async () => {
    const blocked = await createUser("Sec Blocked Lister");
    await createPost(author);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(author.token))
      .expect(201);

    // The same 404 the profile itself gives — not an empty array, which would
    // confirm the account exists.
    await request(app)
      .get(`/api/v1/users/${author.username}/posts`)
      .set(...bearer(blocked.token))
      .expect(404);
  });

  it("is directional: the blocker still sees the blocked user's posts", async () => {
    const blocked = await createUser("Sec Blocked Author");
    const id = await createPost(blocked);

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(author.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(author.token))
      .expect(200);
  });
});

/* ── Admin ──────────────────────────────────────────────────────────────── */

describe("Admin override", () => {
  it("reads a private post", async () => {
    const id = await createPost(author, { visibility: "private" });

    await request(app)
      .get(`/api/v1/posts/${id}`)
      .set(...bearer(adminToken))
      .expect(200);
  });

  it("may delete but never edit someone else's post", async () => {
    // Moderation removes content; it does not rewrite it in someone's voice.
    const id = await createPost(author);

    await request(app)
      .patch(`/api/v1/posts/${id}`)
      .set(...bearer(adminToken))
      .send({ content: "rewritten by admin" })
      .expect(403);

    await request(app)
      .delete(`/api/v1/posts/${id}`)
      .set(...bearer(adminToken))
      .expect(200);
  });

  it("may delete a comment as a moderator", async () => {
    const id = await createPost(author);
    const created = await request(app)
      .post(`/api/v1/posts/${id}/comments`)
      .set(...bearer(outsider.token))
      .send({ content: "moderate me" })
      .expect(201);

    await request(app)
      .delete(`/api/v1/comments/${created.body.data.comment.id}`)
      .set(...bearer(adminToken))
      .expect(200);
  });
});

/* ── Authentication ─────────────────────────────────────────────────────── */

describe("Anonymous writes", () => {
  it("401s every mutating route", async () => {
    const id = await createPost(author);
    const created = await request(app)
      .post(`/api/v1/posts/${id}/comments`)
      .set(...bearer(author.token))
      .send({ content: "c" })
      .expect(201);
    const commentId = created.body.data.comment.id as string;

    const cases: [string, string][] = [
      ["post", "/api/v1/posts"],
      ["patch", `/api/v1/posts/${id}`],
      ["delete", `/api/v1/posts/${id}`],
      ["post", `/api/v1/posts/${id}/comments`],
      ["post", `/api/v1/posts/${id}/like`],
      ["delete", `/api/v1/posts/${id}/like`],
      ["post", `/api/v1/posts/${id}/bookmark`],
      ["delete", `/api/v1/posts/${id}/bookmark`],
      ["post", `/api/v1/posts/${id}/poll/vote`],
      ["patch", `/api/v1/comments/${commentId}`],
      ["delete", `/api/v1/comments/${commentId}`],
      ["post", `/api/v1/comments/${commentId}/like`],
      ["delete", `/api/v1/comments/${commentId}/like`],
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
  it("never exposes a credential column, soft-delete marker, or communityId", async () => {
    const id = await createPost(author);
    await request(app)
      .post(`/api/v1/posts/${id}/comments`)
      .set(...bearer(outsider.token))
      .send({ content: "hello" })
      .expect(201);

    for (const path of [...childReads(id), "/api/v1/feed"]) {
      const response = await request(app)
        .get(path)
        .set(...bearer(author.token))
        .expect(200);

      const body = JSON.stringify(response.body);
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("deletedAt");
      expect(body).not.toContain("communityId");
      expect(body).not.toContain("@forgehub.test");
    }
  });

  it("carries the standard envelope on every post response", async () => {
    const id = await createPost(author);

    const single = await request(app).get(`/api/v1/posts/${id}`).expect(200);
    expect(single.body).toMatchObject({ success: true, error: null });
    expect(typeof single.body.message).toBe("string");
  });

  it("emits the poll in the frontend's shape with additive keys only", async () => {
    const response = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(author.token))
      .send({
        type: "poll",
        content: "Vote",
        poll: { question: "Which?", options: ["A", "B"] },
      })
      .expect(201);

    const poll = response.body.data.post.poll as Record<string, unknown>;
    expect(Object.keys(poll).sort()).toEqual([
      "closesAt",
      "id",
      "isClosed",
      "options",
      "question",
      "votedOptionId",
    ]);

    const option = (poll["options"] as Record<string, unknown>[])[0];
    // The frontend's PollOption is exactly {id,label,voteCount} — no position.
    expect(Object.keys(option ?? {}).sort()).toEqual(["id", "label", "voteCount"]);
  });
});

/* ── OpenAPI synchronization ────────────────────────────────────────────── */

describe("OpenAPI synchronization", () => {
  it("documents every post, comment, and feed route the routers mount", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const paths = Object.keys(response.body.paths as Record<string, unknown>);

    expect(paths).toEqual(
      expect.arrayContaining([
        "/posts",
        "/posts/{id}",
        "/posts/{id}/comments",
        "/posts/{id}/like",
        "/posts/{id}/bookmark",
        "/posts/{id}/poll/vote",
        "/comments/{id}",
        "/comments/{id}/replies",
        "/comments/{id}/like",
        "/feed",
        "/feed/new-count",
        "/users/{username}/posts",
        "/users/me/bookmarks",
      ]),
    );
  });

  it("documents the Post schema as exactly the frontend's contract", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const required = response.body.components.schemas.Post.required as string[];

    expect([...required].sort()).toEqual([
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
    ]);
  });

  it("resolves every $ref in the document", async () => {
    // A dangling $ref is invisible to tsc — it is just a string.
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

  it("does not document communityId anywhere on the Post schema", async () => {
    const response = await request(app).get("/api/v1/openapi.json").expect(200);
    const post = JSON.stringify(response.body.components.schemas.Post as unknown);

    expect(post).not.toContain("communityId");
  });
});
