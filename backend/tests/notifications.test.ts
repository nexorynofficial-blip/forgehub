import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Notifications over HTTP, end to end (TRD §22, ARCHITECTURE §16).
 *
 * The suppression matrix has its own exhaustive unit suite and the persistence
 * rules have their own repository suite; this file proves the two are actually
 * *wired* to real domain events. A correct notification service that no
 * business operation ever calls is worth nothing, and only a request through
 * the real endpoints can show the seven Phase 4–8 triggers are live.
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

const NS = "notifapi";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/notifications";

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

async function createUser(): Promise<TestUser> {
  const email = uniqueEmail();

  await request(app)
    .post("/api/v1/auth/register")
    .send({
      displayName: "Notify Tester",
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

/** The caller's notification list. */
async function listFor(user: TestUser, query: Record<string, string> = {}) {
  const response = await request(app)
    .get(BASE)
    .query(query)
    .set(...bearer(user.token))
    .expect(200);
  return response.body.data;
}

async function createPost(author: TestUser, content: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/posts")
    .set(...bearer(author.token))
    .send({ type: "text", content })
    .expect(201);
  return response.body.data.post.id as string;
}

beforeAll(async () => {
  await connectRedis();
}, 60_000);

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    // This suite exercises every trigger, so its users own posts, projects,
    // communities, and conversations. `Post.authorId` and `Project.ownerId`
    // are Restrict rather than Cascade, so those aggregates come out first.
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { actorId: { in: ids } }] },
    });
    await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.community.deleteMany({ where: { ownerId: { in: ids } } });

    const conversations = await prisma.conversation.findMany({
      where: { members: { some: { userId: { in: ids } } } },
      select: { id: true },
    });
    await prisma.conversation.deleteMany({
      where: { id: { in: conversations.map((row) => row.id) } },
    });

    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
  await redis.quit();
});

/* ── The list endpoint ───────────────────────────────────────────────────── */

describe("GET /notifications", () => {
  it("starts empty for a new account", async () => {
    const user = await createUser();
    const data = await listFor(user);

    expect(data.items).toEqual([]);
    expect(data.unreadCount).toBe(0);
    expect(data.nextCursor).toBeNull();
  });

  it("serves the unread count alongside the page", async () => {
    // The panel renders both; a separate request per render would be waste.
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const data = await listFor(recipient);
    expect(data.items).toHaveLength(1);
    expect(data.unreadCount).toBe(1);
  });

  it("projects the actor without leaking anything beyond a summary", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const notification = (await listFor(recipient)).items[0];

    expect(notification.actor).toEqual({
      id: actor.userId,
      username: actor.username,
      displayName: "Notify Tester",
      avatarUrl: null,
    });
    // Flat fields the shipped `NotificationWithActor` reads.
    expect(notification.actorName).toBe("Notify Tester");
    expect(notification.actorAvatarUrl).toBeNull();
    // Nothing about the actor's standing on the platform.
    expect(notification.actor).not.toHaveProperty("email");
    expect(notification.actor).not.toHaveProperty("role");
    expect(notification.actor).not.toHaveProperty("builderRank");
  });

  it("filters to unread when asked", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];
    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const first = (await listFor(recipient)).items[0];
    await request(app)
      .post(`${BASE}/${first.id as string}/read`)
      .set(...bearer(recipient.token))
      .expect(200);

    expect((await listFor(recipient, { unreadOnly: "true" })).items).toEqual([]);
    expect((await listFor(recipient)).items).toHaveLength(1);
  });

  it("pages with a cursor", async () => {
    const recipient = await createUser();

    // Three distinct actors, so the collapse rule does not merge them.
    for (let index = 0; index < 3; index += 1) {
      const actor = await createUser();
      await request(app)
        .post(`/api/v1/users/${recipient.username}/follow`)
        .set(...bearer(actor.token))
        .expect(201);
    }

    const first = await listFor(recipient, { limit: "2" });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listFor(recipient, {
      limit: "2",
      cursor: first.nextCursor as string,
    });
    const firstIds = first.items.map((item: { id: string }) => item.id);
    expect(second.items.some((item: { id: string }) => firstIds.includes(item.id))).toBe(
      false,
    );
  });

  it("requires authentication", async () => {
    await request(app).get(BASE).expect(401);
  });
});

/* ── The seven Phase 4–8 triggers, now live ──────────────────────────────── */

describe("existing triggers are activated", () => {
  it("notifies on a follow", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const notification = (await listFor(recipient)).items[0];
    expect(notification.type).toBe("follower");
    expect(notification.message).toContain("started following you");
    expect(notification.actorId).toBe(actor.userId);
  });

  it("notifies on a post like", async () => {
    const [author, liker] = [await createUser(), await createUser()];
    const postId = await createPost(author, "like this");

    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(liker.token))
      .expect(201);

    const notification = (await listFor(author)).items[0];
    expect(notification.type).toBe("like");
    expect(notification.entityType).toBe("post");
    expect(notification.targetId).toBe(postId);
  });

  it("notifies on a comment", async () => {
    const [author, commenter] = [await createUser(), await createUser()];
    const postId = await createPost(author, "comment on this");

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "nice work" })
      .expect(201);

    const notification = (await listFor(author)).items[0];
    expect(notification.type).toBe("comment");
    expect(notification.entityType).toBe("post");
  });

  it("notifies on a reply, distinctly from a comment", async () => {
    const [author, commenter, replier] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const postId = await createPost(author, "thread starter");

    const comment = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: "first" })
      .expect(201);

    await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(replier.token))
      .send({ content: "replying", parentCommentId: comment.body.data.comment.id })
      .expect(201);

    const notification = (await listFor(commenter)).items[0];
    expect(notification.type).toBe("reply");
    expect(notification.entityType).toBe("comment");
  });

  it("notifies on a mention in a post, targeting the post", async () => {
    const [mentioned, author] = [await createUser(), await createUser()];

    const postId = await createPost(author, `hello @${mentioned.username} look here`);

    const notification = (await listFor(mentioned)).items[0];
    expect(notification.type).toBe("mention");
    expect(notification.entityType).toBe("post");
    expect(notification.targetId).toBe(postId);
  });

  it("notifies on a mention in a comment, targeting the COMMENT", async () => {
    // Phase 9 regression test for the corrected `entityType`. Before the fix
    // this recorded `post` alongside a comment id, so the notification
    // deep-linked to a post that does not exist.
    const [mentioned, author, commenter] = [
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const postId = await createPost(author, "a post to comment on");

    const comment = await request(app)
      .post(`/api/v1/posts/${postId}/comments`)
      .set(...bearer(commenter.token))
      .send({ content: `hey @${mentioned.username}` })
      .expect(201);

    const commentId = comment.body.data.comment.id as string;
    const notification = (await listFor(mentioned)).items[0];

    expect(notification.type).toBe("mention");
    expect(notification.entityType).toBe("comment");
    expect(notification.targetId).toBe(commentId);
    expect(notification.targetId).not.toBe(postId);
  });

  it("notifies on a project like", async () => {
    const [owner, liker] = [await createUser(), await createUser()];

    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: "Atlas Engine", description: "A project for notification tests." })
      .expect(201);

    const slug = project.body.data.project.slug as string;
    await request(app)
      .post(`/api/v1/projects/${slug}/like`)
      .set(...bearer(liker.token))
      .expect(201);

    const notification = (await listFor(owner)).items[0];
    expect(notification.type).toBe("like");
    expect(notification.entityType).toBe("project");
  });

  it("notifies on a project invitation", async () => {
    const [owner, invitee] = [await createUser(), await createUser()];

    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: "Beacon Relay", description: "Another notification test project." })
      .expect(201);

    const slug = project.body.data.project.slug as string;
    await request(app)
      .post(`/api/v1/projects/${slug}/members`)
      .set(...bearer(owner.token))
      .send({ username: invitee.username, role: "contributor" })
      .expect(201);

    const notification = (await listFor(invitee)).items[0];
    expect(notification.type).toBe("project_invite");
    expect(notification.entityType).toBe("project");
    // The rendered sentence must name the project, not trail off after "the
    // project". The Phase 5 call site passed no `subject`, which rendered
    // "… added you to the project." — correct-looking and useless. The regex
    // is anchored so dropping the subject again fails here rather than
    // producing text nobody reads closely enough to notice.
    expect(notification.message).toMatch(/added you to the project Beacon Relay\.$/);
  });
});

/* ── The new Phase 9 triggers ────────────────────────────────────────────── */

describe("new Phase 9 triggers", () => {
  it("notifies on a community invitation", async () => {
    const [owner, invitee] = [await createUser(), await createUser()];

    const community = await request(app)
      .post("/api/v1/communities")
      .set(...bearer(owner.token))
      .send({
        name: `Notify Guild ${String(Date.now())}`,
        description: "A community for notification tests.",
        category: "Design",
      })
      .expect(201);

    const slug = community.body.data.community.slug as string;
    await request(app)
      .post(`/api/v1/communities/${slug}/members`)
      .set(...bearer(owner.token))
      .send({ username: invitee.username })
      .expect(201);

    const notification = (await listFor(invitee)).items[0];
    expect(notification.type).toBe("community_invite");
    expect(notification.entityType).toBe("community");
    expect(notification.message).toContain("Notify Guild");
  });

  it("does not notify someone who joins a community themselves", async () => {
    // Joining is a different code path from being added, and you already know
    // that you joined.
    const [owner, joiner] = [await createUser(), await createUser()];

    const community = await request(app)
      .post("/api/v1/communities")
      .set(...bearer(owner.token))
      .send({
        name: `Open Guild ${String(Date.now())}`,
        description: "A public community anyone may join.",
        category: "Design",
      })
      .expect(201);

    const slug = community.body.data.community.slug as string;
    await request(app)
      .post(`/api/v1/communities/${slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);

    expect((await listFor(joiner)).items).toEqual([]);
  });

  it("notifies on a direct message, keyed on the conversation", async () => {
    const [sender, recipient] = [await createUser(), await createUser()];

    const conversation = await request(app)
      .post("/api/v1/messages/conversations")
      .set(...bearer(sender.token))
      .send({ username: recipient.username })
      .expect(201);

    const conversationId = conversation.body.data.conversation.id as string;
    await request(app)
      .post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set(...bearer(sender.token))
      .send({ content: "hello there" })
      .expect(201);

    const notification = (await listFor(recipient)).items[0];
    expect(notification.type).toBe("message");
    expect(notification.entityType).toBe("conversation");
    expect(notification.targetId).toBe(conversationId);
  });

  it("collapses a burst of messages into one unread notification", async () => {
    // The reason a chat does not become a notification firehose.
    const [sender, recipient] = [await createUser(), await createUser()];

    const conversation = await request(app)
      .post("/api/v1/messages/conversations")
      .set(...bearer(sender.token))
      .send({ username: recipient.username })
      .expect(201);

    const conversationId = conversation.body.data.conversation.id as string;
    for (let index = 0; index < 4; index += 1) {
      await request(app)
        .post(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set(...bearer(sender.token))
        .send({ content: `message ${String(index)}` })
        .expect(201);
    }

    const data = await listFor(recipient);
    expect(data.items).toHaveLength(1);
    expect(data.unreadCount).toBe(1);
  });

  it("notifies project followers when an update is posted", async () => {
    const [owner, follower] = [await createUser(), await createUser()];

    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: "Fanout Works", description: "A project with followers." })
      .expect(201);

    const slug = project.body.data.project.slug as string;
    await request(app)
      .post(`/api/v1/projects/${slug}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "We shipped the first milestone today." })
      .expect(201);

    const notification = (await listFor(follower)).items.find(
      (item: { type: string }) => item.type === "project_update",
    );
    expect(notification).toBeDefined();
    expect(notification.entityType).toBe("project");
    expect(notification.message).toContain("Fanout Works");
  });

  it("does not notify the update's own author", async () => {
    const owner = await createUser();

    const project = await request(app)
      .post("/api/v1/projects")
      .set(...bearer(owner.token))
      .send({ title: "Self Fanout", description: "The owner follows their own work." })
      .expect(201);

    const slug = project.body.data.project.slug as string;
    await request(app)
      .post(`/api/v1/projects/${slug}/updates`)
      .set(...bearer(owner.token))
      .send({ content: "An update nobody else follows." })
      .expect(201);

    expect(
      (await listFor(owner)).items.filter(
        (item: { type: string }) => item.type === "project_update",
      ),
    ).toEqual([]);
  });
});

/* ── Read state ──────────────────────────────────────────────────────────── */

describe("read state", () => {
  async function withOneNotification(): Promise<{ user: TestUser; id: string }> {
    const [recipient, actor] = [await createUser(), await createUser()];
    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const id = (await listFor(recipient)).items[0].id as string;
    return { user: recipient, id };
  }

  it("marks one read", async () => {
    const { user, id } = await withOneNotification();

    const response = await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.notification.isRead).toBe(true);
    expect(response.body.data.notification.readAt).not.toBeNull();
    expect((await listFor(user)).unreadCount).toBe(0);
  });

  it("is idempotent and preserves the original readAt", async () => {
    const { user, id } = await withOneNotification();

    const first = await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(user.token))
      .expect(200);

    const second = await request(app)
      .post(`${BASE}/${id}/read`)
      .set(...bearer(user.token))
      .expect(200);

    expect(second.body.data.notification.readAt).toBe(
      first.body.data.notification.readAt,
    );
  });

  it("reports the unread count on its own endpoint", async () => {
    const { user } = await withOneNotification();

    const response = await request(app)
      .get(`${BASE}/unread`)
      .set(...bearer(user.token))
      .expect(200);

    expect(response.body.data.unreadCount).toBe(1);
  });

  it("marks all read and reports how many flipped", async () => {
    const recipient = await createUser();
    for (let index = 0; index < 3; index += 1) {
      const actor = await createUser();
      await request(app)
        .post(`/api/v1/users/${recipient.username}/follow`)
        .set(...bearer(actor.token))
        .expect(201);
    }

    const response = await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(recipient.token))
      .expect(200);

    expect(response.body.data.markedRead).toBe(3);
    expect(response.body.data.unreadCount).toBe(0);
  });

  it("treats a second mark-all as a success that flipped nothing", async () => {
    const { user } = await withOneNotification();

    await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(user.token))
      .expect(200);

    const second = await request(app)
      .post(`${BASE}/read-all`)
      .set(...bearer(user.token))
      .expect(200);

    expect(second.body.data.markedRead).toBe(0);
  });

  it("422s a malformed notification id rather than reaching the database", async () => {
    const user = await createUser();
    await request(app)
      .post(`${BASE}/not-a-uuid/read`)
      .set(...bearer(user.token))
      .expect(422);
  });
});

/* ── Preferences ─────────────────────────────────────────────────────────── */

describe("preference enforcement", () => {
  it("does not persist a notification for a muted type", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(recipient.token))
      .send({ type: "follower", inApp: false })
      .expect(200);

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    // inApp:false prevents persistence, not merely display.
    expect((await listFor(recipient)).items).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: recipient.userId } })).toBe(
      0,
    );
  });

  it("leaves other types unaffected", async () => {
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(recipient.token))
      .send({ type: "follower", inApp: false })
      .expect(200);

    const postId = await createPost(recipient, "still notifies");
    await request(app)
      .post(`/api/v1/posts/${postId}/like`)
      .set(...bearer(actor.token))
      .expect(201);

    expect((await listFor(recipient)).items).toHaveLength(1);
  });

  it("does not break the follow itself when notifications are muted", async () => {
    // The port is fire-and-forget: suppression is not a failure.
    const [recipient, actor] = [await createUser(), await createUser()];

    await request(app)
      .patch("/api/v1/users/me/notification-preferences")
      .set(...bearer(recipient.token))
      .send({ type: "follower", inApp: false })
      .expect(200);

    await request(app)
      .post(`/api/v1/users/${recipient.username}/follow`)
      .set(...bearer(actor.token))
      .expect(201);

    const relationship = await request(app)
      .get(`/api/v1/users/${recipient.username}`)
      .set(...bearer(actor.token))
      .expect(200);

    expect(relationship.body.data.relationship.isFollowing).toBe(true);
  });
});
