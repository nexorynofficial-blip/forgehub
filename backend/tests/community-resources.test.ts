import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Community-owned resources over HTTP: rules, tags, events, and pins
 * (decisions J8, J10, J11, J14), plus community posts and the Phase 6 seam
 * (decisions J2, J3).
 *
 * The seam cases are the ones worth the most scrutiny. Phase 6 hid every
 * community post from everyone but its author; Phase 7 replaced that with a
 * real membership test, and a mistake here leaks private-community content
 * into a global feed that everyone reads.
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

const NS = "cres";
const PASSWORD = "ValidPass123";
const BASE = "/api/v1/communities";

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

async function createUser(displayName = "Res Tester"): Promise<TestUser> {
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
async function makeCommunity(
  actor: TestUser,
  body: Record<string, unknown> = {},
): Promise<{ slug: string; id: string }> {
  n += 1;
  const response = await request(app)
    .post(BASE)
    .set(...bearer(actor.token))
    .send({ name: `${NS} Community ${String(n)}`, category: "Testing", ...body })
    .expect(201);

  const community = response.body.data.community as { id: string; slug: string };
  return { slug: community.slug, id: community.id };
}

async function seat(
  slug: string,
  owner: TestUser,
  target: TestUser,
  role: string,
): Promise<void> {
  await request(app)
    .post(`${BASE}/${slug}/members`)
    .set(...bearer(owner.token))
    .send({ username: target.username, role })
    .expect(201);
}

async function usage(tagId: string): Promise<number> {
  const row = await prisma.tag.findUniqueOrThrow({
    where: { id: tagId },
    select: { usageCount: true },
  });
  return row.usageCount;
}

let owner: TestUser;
let admin: TestUser;
let moderator: TestUser;
let plain: TestUser;
let outsider: TestUser;
let tag: { id: string; name: string };

beforeAll(async () => {
  await connectRedis();
  owner = await createUser("Res Owner");
  admin = await createUser("Res Admin");
  moderator = await createUser("Res Moderator");
  plain = await createUser("Res Member");
  outsider = await createUser("Res Outsider");
  tag = await prisma.tag.findFirstOrThrow({ select: { id: true, name: true } });
});

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const ids = users.map((user) => user.id);

  if (ids.length > 0) {
    const communities = await prisma.community.findMany({
      where: { ownerId: { in: ids } },
      select: { id: true },
    });
    const communityIds = communities.map((row) => row.id);

    if (communityIds.length > 0) {
      const held = await prisma.communityTag.findMany({
        where: { communityId: { in: communityIds } },
        select: { tagId: true },
      });
      await prisma.communityTag.deleteMany({
        where: { communityId: { in: communityIds } },
      });
      for (const { tagId } of held) {
        await prisma.tag.updateMany({
          where: { id: tagId, usageCount: { gt: 0 } },
          data: { usageCount: { decrement: 1 } },
        });
      }
      await prisma.post.deleteMany({ where: { communityId: { in: communityIds } } });
      await prisma.community.deleteMany({ where: { id: { in: communityIds } } });
    }

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

/* ══ Rules (decision J11) ═════════════════════════════════════════════════ */

describe("Rules", () => {
  it("replaces the list and preserves the submitted order", async () => {
    const community = await makeCommunity(owner);

    const response = await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["Be kind", "Stay on topic", "No spam"] })
      .expect(200);

    expect(response.body.data.community.rules).toEqual([
      "Be kind",
      "Stay on topic",
      "No spam",
    ]);
  });

  it("replaces rather than appends, and reorders in place", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["A", "B", "C"] })
      .expect(200);

    const second = await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["C", "A"] })
      .expect(200);

    expect(second.body.data.community.rules).toEqual(["C", "A"]);

    const stored = await prisma.communityRule.findMany({
      where: { communityId: community.id },
      select: { content: true, position: true },
      orderBy: { position: "asc" },
    });
    expect(stored).toEqual([
      { content: "C", position: 0 },
      { content: "A", position: 1 },
    ]);
  });

  it("clears the list with an empty array", async () => {
    const community = await makeCommunity(owner);
    await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["Something"] })
      .expect(200);

    const cleared = await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: [] })
      .expect(200);

    expect(cleared.body.data.community.rules).toEqual([]);
  });

  it("rejects an empty or over-long rule", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["Fine", "   "] })
      .expect(422);

    await request(app)
      .put(`${BASE}/${community.slug}/rules`)
      .set(...bearer(owner.token))
      .send({ rules: ["x".repeat(501)] })
      .expect(422);
  });

  it("is admin-and-above: a moderator cannot rewrite the charter", async () => {
    const community = await makeCommunity(owner);
    await seat(community.slug, owner, admin, "admin");
    await seat(community.slug, owner, moderator, "moderator");
    await seat(community.slug, owner, plain, "member");

    for (const [actor, expected] of [
      [owner, 200],
      [admin, 200],
      [moderator, 403],
      [plain, 403],
      [outsider, 403],
    ] as const) {
      await request(app)
        .put(`${BASE}/${community.slug}/rules`)
        .set(...bearer(actor.token))
        .send({ rules: ["Set by " + actor.username] })
        .expect(expected);
    }
  });
});

/* ══ Tags (decision J8) ═══════════════════════════════════════════════════ */

describe("Tags", () => {
  it("attaches an existing tag and increments the shared counter", async () => {
    const before = await usage(tag.id);
    const community = await makeCommunity(owner);

    const response = await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [tag.name] })
      .expect(200);

    expect(response.body.data.community.tags).toEqual([tag.name]);
    expect(await usage(tag.id)).toBe(before + 1);
  });

  it("refuses an unknown tag rather than creating one", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: ["definitely-not-a-real-tag-xyz"] })
      .expect(422);

    const created = await prisma.tag.findFirst({
      where: { slug: "definitely-not-a-real-tag-xyz" },
    });
    expect(created).toBeNull();
  });

  it("survives repeated add/remove without drifting the counter", async () => {
    const before = await usage(tag.id);
    const community = await makeCommunity(owner);

    for (const _ of [1, 2, 3]) {
      await request(app)
        .put(`${BASE}/${community.slug}/tags`)
        .set(...bearer(owner.token))
        .send({ tags: [tag.name] })
        .expect(200);
      expect(await usage(tag.id)).toBe(before + 1);

      await request(app)
        .put(`${BASE}/${community.slug}/tags`)
        .set(...bearer(owner.token))
        .send({ tags: [] })
        .expect(200);
      expect(await usage(tag.id)).toBe(before);
    }
  });

  it("does not double-count a re-submitted identical set", async () => {
    const before = await usage(tag.id);
    const community = await makeCommunity(owner);

    for (const _ of [1, 2, 3]) {
      await request(app)
        .put(`${BASE}/${community.slug}/tags`)
        .set(...bearer(owner.token))
        .send({ tags: [tag.name] })
        .expect(200);
    }

    // The delta is computed against what is already attached, so re-sending the
    // same set is a no-op rather than three increments.
    expect(await usage(tag.id)).toBe(before + 1);
  });

  it("does not double-count a name and its slug in one request", async () => {
    const before = await usage(tag.id);
    const community = await makeCommunity(owner);
    const slugForm = tag.name.toLowerCase().replace(/\s+/g, "-");

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [tag.name, slugForm] })
      .expect(200);

    expect(await usage(tag.id)).toBe(before + 1);
  });

  it("leaves a project's usage intact when a community detaches", async () => {
    // One counter, two writers (decision J8).
    const before = await usage(tag.id);
    const community = await makeCommunity(owner);

    const project = await prisma.project.create({
      data: {
        slug: `${NS}-tagshare-${String(Date.now())}`,
        ownerId: owner.userId,
        title: "Tag share probe",
        tags: { create: [{ tagId: tag.id }] },
      },
      select: { id: true },
    });
    await prisma.tag.update({
      where: { id: tag.id },
      data: { usageCount: { increment: 1 } },
    });

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [tag.name] })
      .expect(200);
    expect(await usage(tag.id)).toBe(before + 2);

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [] })
      .expect(200);
    expect(await usage(tag.id)).toBe(before + 1);

    await prisma.projectTag.deleteMany({ where: { projectId: project.id } });
    await prisma.tag.updateMany({
      where: { id: tag.id, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
    await prisma.project.delete({ where: { id: project.id } });
  });

  it("never drives the counter negative from the seed's zero state", async () => {
    const community = await makeCommunity(owner);
    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [tag.name] })
      .expect(200);

    // The seed creates tag links without touching the counter, so zero-with-a-
    // link is a real state.
    await prisma.tag.update({ where: { id: tag.id }, data: { usageCount: 0 } });

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(owner.token))
      .send({ tags: [] })
      .expect(200);

    expect(await usage(tag.id)).toBe(0);
  });

  it("keeps the shared counter exact under concurrent tag changes", async () => {
    // Several communities attaching and detaching the same tag at once. The
    // counter is moved by guarded atomic arithmetic inside each transaction,
    // so the end state must equal the number of link rows that survive.
    const before = await usage(tag.id);
    const communities = await Promise.all([
      makeCommunity(owner),
      makeCommunity(owner),
      makeCommunity(owner),
      makeCommunity(owner),
    ]);

    await Promise.all(
      communities.map((c) =>
        request(app)
          .put(`${BASE}/${c.slug}/tags`)
          .set(...bearer(owner.token))
          .send({ tags: [tag.name] }),
      ),
    );

    expect(await usage(tag.id)).toBe(before + communities.length);

    // Detach half of them, again concurrently.
    await Promise.all(
      communities.slice(0, 2).map((c) =>
        request(app)
          .put(`${BASE}/${c.slug}/tags`)
          .set(...bearer(owner.token))
          .send({ tags: [] }),
      ),
    );

    const links = await prisma.communityTag.count({
      where: { tagId: tag.id, communityId: { in: communities.map((c) => c.id) } },
    });
    expect(links).toBe(2);
    expect(await usage(tag.id)).toBe(before + 2);
  });
  it("requires edit_community", async () => {
    const community = await makeCommunity(owner);
    await seat(community.slug, owner, moderator, "moderator");

    await request(app)
      .put(`${BASE}/${community.slug}/tags`)
      .set(...bearer(moderator.token))
      .send({ tags: [tag.name] })
      .expect(403);
  });
});

/* ══ Events (decision J10) ════════════════════════════════════════════════ */

describe("Events", () => {
  const future = () => new Date(Date.now() + 86_400_000).toISOString();

  it("creates, reads, updates, and deletes", async () => {
    const community = await makeCommunity(owner);

    const created = await request(app)
      .post(`${BASE}/${community.slug}/events`)
      .set(...bearer(owner.token))
      .send({ title: "Office hours", startsAt: future(), location: "Room 2" })
      .expect(201);

    const eventId = created.body.data.event.id as string;
    expect(created.body.data.event.title).toBe("Office hours");
    expect(created.body.data.event.location).toBe("Room 2");

    const listed = await request(app).get(`${BASE}/${community.slug}/events`).expect(200);
    expect((listed.body.data.events as { id: string }[]).map((e) => e.id)).toContain(
      eventId,
    );

    const updated = await request(app)
      .patch(`${BASE}/${community.slug}/events/${eventId}`)
      .set(...bearer(owner.token))
      .send({ title: "Moved office hours" })
      .expect(200);
    expect(updated.body.data.event.title).toBe("Moved office hours");

    await request(app)
      .delete(`${BASE}/${community.slug}/events/${eventId}`)
      .set(...bearer(owner.token))
      .expect(200);

    const after = await request(app).get(`${BASE}/${community.slug}/events`).expect(200);
    expect((after.body.data.events as { id: string }[]).map((e) => e.id)).not.toContain(
      eventId,
    );
  });

  it("never exposes attendeeCount, which no write path can move", async () => {
    const community = await makeCommunity(owner);
    const created = await request(app)
      .post(`${BASE}/${community.slug}/events`)
      .set(...bearer(owner.token))
      .send({ title: "No RSVP", startsAt: future(), attendeeCount: 500 })
      .expect(201);

    expect(created.body.data.event).not.toHaveProperty("attendeeCount");

    // …and the field the client sent was ignored, not stored.
    const row = await prisma.communityEvent.findUniqueOrThrow({
      where: { id: created.body.data.event.id as string },
      select: { attendeeCount: true },
    });
    expect(row.attendeeCount).toBe(0);
  });

  it("projects the four fields the frontend reads on the community payload", async () => {
    const community = await makeCommunity(owner);
    await request(app)
      .post(`${BASE}/${community.slug}/events`)
      .set(...bearer(owner.token))
      .send({ title: "Public shape", startsAt: future(), description: "internal" })
      .expect(201);

    const detail = await request(app).get(`${BASE}/${community.slug}`).expect(200);
    const event = detail.body.data.community.events[0] as Record<string, unknown>;

    expect(Object.keys(event).sort()).toEqual(["endsAt", "id", "startsAt", "title"]);
  });

  it("rejects an end before the start, on create and on patch", async () => {
    const community = await makeCommunity(owner);

    await request(app)
      .post(`${BASE}/${community.slug}/events`)
      .set(...bearer(owner.token))
      .send({
        title: "Backwards",
        startsAt: "2026-09-01T17:00:00.000Z",
        endsAt: "2026-09-01T09:00:00.000Z",
      })
      .expect(422);

    const created = await request(app)
      .post(`${BASE}/${community.slug}/events`)
      .set(...bearer(owner.token))
      .send({
        title: "Fine",
        startsAt: "2026-09-01T09:00:00.000Z",
        endsAt: "2026-09-01T17:00:00.000Z",
      })
      .expect(201);

    // Moving only the start, checked against the *stored* end.
    await request(app)
      .patch(`${BASE}/${community.slug}/events/${created.body.data.event.id as string}`)
      .set(...bearer(owner.token))
      .send({ startsAt: "2026-09-02T09:00:00.000Z" })
      .expect(422);
  });

  it("is moderator-and-above", async () => {
    const community = await makeCommunity(owner);
    await seat(community.slug, owner, moderator, "moderator");
    await seat(community.slug, owner, plain, "member");

    for (const [actor, expected] of [
      [owner, 201],
      [moderator, 201],
      [plain, 403],
      [outsider, 403],
    ] as const) {
      await request(app)
        .post(`${BASE}/${community.slug}/events`)
        .set(...bearer(actor.token))
        .send({ title: `By ${actor.username}`, startsAt: future() })
        .expect(expected);
    }
  });

  it("404s an event id from another community", async () => {
    const a = await makeCommunity(owner);
    const b = await makeCommunity(owner);

    const created = await request(app)
      .post(`${BASE}/${a.slug}/events`)
      .set(...bearer(owner.token))
      .send({ title: "In A", startsAt: future() })
      .expect(201);

    await request(app)
      .patch(`${BASE}/${b.slug}/events/${created.body.data.event.id as string}`)
      .set(...bearer(owner.token))
      .send({ title: "Hijack" })
      .expect(404);
  });
});

/* ══ Pins (decision J14) ══════════════════════════════════════════════════ */

describe("Pinned posts", () => {
  async function communityWithPost(): Promise<{
    slug: string;
    id: string;
    postId: string;
  }> {
    const community = await makeCommunity(owner, { visibility: "public" });
    const response = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Pinnable post" })
      .expect(201);

    return { ...community, postId: response.body.data.post.id as string };
  }

  it("pins and unpins, reflecting the change on the community payload", async () => {
    const { slug, postId } = await communityWithPost();

    const pinned = await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId })
      .expect(201);
    expect(pinned.body.data.pinnedPostIds).toContain(postId);

    const detail = await request(app).get(`${BASE}/${slug}`).expect(200);
    expect(detail.body.data.community.pinnedPostIds).toContain(postId);

    const unpinned = await request(app)
      .delete(`${BASE}/${slug}/pins/${postId}`)
      .set(...bearer(owner.token))
      .expect(200);
    expect(unpinned.body.data.pinnedPostIds).not.toContain(postId);
  });

  it("409s a duplicate pin, and creates only one row", async () => {
    const { id, slug, postId } = await communityWithPost();

    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId })
      .expect(201);
    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId })
      .expect(409);

    const rows = await prisma.communityPinnedPost.count({ where: { communityId: id } });
    expect(rows).toBe(1);
  });

  it("records pinnedById", async () => {
    const { id, slug, postId } = await communityWithPost();
    await seat(slug, owner, moderator, "moderator");

    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(moderator.token))
      .send({ postId })
      .expect(201);

    const row = await prisma.communityPinnedPost.findUniqueOrThrow({
      where: { communityId_postId: { communityId: id, postId } },
      select: { pinnedById: true },
    });
    expect(row.pinnedById).toBe(moderator.userId);
  });

  it("404s a post that belongs to another community", async () => {
    const a = await communityWithPost();
    const b = await makeCommunity(owner, { visibility: "public" });

    await request(app)
      .post(`${BASE}/${b.slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId: a.postId })
      .expect(404);
  });

  it("404s an ordinary post with no community at all", async () => {
    const community = await makeCommunity(owner);
    const loose = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(owner.token))
      .send({ content: "Not in any community" })
      .expect(201);

    await request(app)
      .post(`${BASE}/${community.slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId: loose.body.data.post.id as string })
      .expect(404);
  });

  it("404s a soft-deleted post", async () => {
    const { slug, postId } = await communityWithPost();

    await request(app)
      .delete(`/api/v1/posts/${postId}`)
      .set(...bearer(owner.token))
      .expect(200);

    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId })
      .expect(404);
  });

  it("drops a pinned post from the list once it is deleted", async () => {
    const { slug, postId } = await communityWithPost();

    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId })
      .expect(201);

    await request(app)
      .delete(`/api/v1/posts/${postId}`)
      .set(...bearer(owner.token))
      .expect(200);

    const pins = await request(app).get(`${BASE}/${slug}/pins`).expect(200);
    expect(pins.body.data.pinnedPostIds).not.toContain(postId);
  });

  it("is moderator-and-above", async () => {
    const { slug, postId } = await communityWithPost();
    await seat(slug, owner, plain, "member");

    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(plain.token))
      .send({ postId })
      .expect(403);
    await request(app)
      .post(`${BASE}/${slug}/pins`)
      .set(...bearer(outsider.token))
      .send({ postId })
      .expect(403);
  });

  it("404s a private post written by someone else", async () => {
    // The pinner must be able to read it. Otherwise its id lands in
    // `pinnedPostIds` for everyone who can see the community, pointing at
    // something nobody can open.
    const community = await makeCommunity(owner, { visibility: "public" });
    const author = await createUser();
    await seat(community.slug, owner, author, "member");

    const secret = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(author.token))
      .send({ content: "Private to me", visibility: "private" })
      .expect(201);

    await request(app)
      .post(`${BASE}/${community.slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId: secret.body.data.post.id as string })
      .expect(404);
  });

  it("lets an author pin their own private post", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const secret = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Mine", visibility: "private" })
      .expect(201);

    await request(app)
      .post(`${BASE}/${community.slug}/pins`)
      .set(...bearer(owner.token))
      .send({ postId: secret.body.data.post.id as string })
      .expect(201);
  });
  it("404s unpinning something that is not pinned", async () => {
    const { slug, postId } = await communityWithPost();

    await request(app)
      .delete(`${BASE}/${slug}/pins/${postId}`)
      .set(...bearer(owner.token))
      .expect(404);
  });
});

/* ══ Community posts and the Phase 6 seam (decisions J2, J3) ══════════════ */

describe("Community posts", () => {
  it("creates a post whose communityId came from the route", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });

    const response = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "From the route" })
      .expect(201);

    const postId = response.body.data.post.id as string;
    const row = await prisma.post.findUniqueOrThrow({
      where: { id: postId },
      select: { communityId: true, authorId: true },
    });

    expect(row.communityId).toBe(community.id);
    expect(row.authorId).toBe(owner.userId);
    // Still never projected (decision J9's projection rule survives).
    expect(response.body.data.post).not.toHaveProperty("communityId");
  });

  it("gives a client-supplied communityId no effect whatsoever", async () => {
    // `createPostSchema` has no `communityId` key, and Zod strips unknown ones
    // — the Phase 4–6 convention. So the spoofed value never reaches a
    // repository, and the post lands in the community the *route* named.
    const a = await makeCommunity(owner, { visibility: "public" });
    const b = await makeCommunity(owner, { visibility: "public" });

    const response = await request(app)
      .post(`${BASE}/${a.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Spoof attempt", communityId: b.id })
      .expect(201);

    const row = await prisma.post.findUniqueOrThrow({
      where: { id: response.body.data.post.id as string },
      select: { communityId: true },
    });

    expect(row.communityId).toBe(a.id);
    expect(row.communityId).not.toBe(b.id);
  });

  it("gives a client-supplied authorId no effect either", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });

    const response = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Author spoof", authorId: outsider.userId })
      .expect(201);

    const row = await prisma.post.findUniqueOrThrow({
      where: { id: response.body.data.post.id as string },
      select: { authorId: true },
    });

    // Identity comes from the verified token, never the payload.
    expect(row.authorId).toBe(owner.userId);
  });

  it("refuses a non-member, even in a public community", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });

    await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(outsider.token))
      .send({ content: "Not a member" })
      .expect(403);
  });

  it("accepts a member once they have joined", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await request(app)
      .post(`${BASE}/${community.slug}/join`)
      .set(...bearer(joiner.token))
      .expect(201);

    await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(joiner.token))
      .send({ content: "Now I am in" })
      .expect(201);
  });

  it("404s a private community's post route for a non-member", async () => {
    const community = await makeCommunity(owner, { visibility: "private" });

    await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(outsider.token))
      .send({ content: "Should not land" })
      .expect(404);
    await request(app)
      .get(`${BASE}/${community.slug}/posts`)
      .set(...bearer(outsider.token))
      .expect(404);
  });

  it("preserves Phase 6 post validation", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });

    await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "" })
      .expect(422);

    await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "x", media: [{ url: "javascript:alert(1)", type: "image" }] })
      .expect(422);
  });

  it("lists the community's posts with cursor pagination", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    for (const i of [1, 2, 3, 4, 5]) {
      await request(app)
        .post(`${BASE}/${community.slug}/posts`)
        .set(...bearer(owner.token))
        .send({ content: `Post ${String(i)}` })
        .expect(201);
    }

    const first = await request(app)
      .get(`${BASE}/${community.slug}/posts`)
      .query({ limit: 3 })
      .expect(200);

    expect(first.body.data.items).toHaveLength(3);
    expect(first.body.data.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`${BASE}/${community.slug}/posts`)
      .query({ limit: 3, cursor: first.body.data.nextCursor })
      .expect(200);

    const firstIds = (first.body.data.items as { id: string }[]).map((p) => p.id);
    const secondIds = (second.body.data.items as { id: string }[]).map((p) => p.id);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it("omits soft-deleted posts from the community listing", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const created = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Doomed" })
      .expect(201);

    const postId = created.body.data.post.id as string;
    await request(app)
      .delete(`/api/v1/posts/${postId}`)
      .set(...bearer(owner.token))
      .expect(200);

    const listed = await request(app).get(`${BASE}/${community.slug}/posts`).expect(200);
    expect((listed.body.data.items as { id: string }[]).map((p) => p.id)).not.toContain(
      postId,
    );
  });
});

describe("Community post visibility (the Phase 6 seam)", () => {
  async function postIn(
    visibility: string,
  ): Promise<{ slug: string; id: string; postId: string; member: TestUser }> {
    const community = await makeCommunity(owner, { visibility });
    const member = await createUser();
    await seat(community.slug, owner, member, "member");

    const response = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(member.token))
      .send({ content: `Post in a ${visibility} community` })
      .expect(201);

    return { ...community, postId: response.body.data.post.id as string, member };
  }

  async function globalFeedIds(token?: string, filter = "latest"): Promise<string[]> {
    const req = request(app).get("/api/v1/feed").query({ filter, limit: 100 });
    if (token) req.set(...bearer(token));
    const response = await req.expect(200);
    return (response.body.data.items as { id: string }[]).map((p) => p.id);
  }

  it("puts a public community's post in the global feed", async () => {
    const { postId } = await postIn("public");

    expect(await globalFeedIds()).toContain(postId);
    expect(await globalFeedIds(outsider.token)).toContain(postId);
  });

  it("keeps a private community's post out of every global filter", async () => {
    const { postId, member } = await postIn("private");

    for (const filter of ["latest", "trending", "recommended", "popular_today"]) {
      expect(await globalFeedIds(undefined, filter)).not.toContain(postId);
      expect(await globalFeedIds(outsider.token, filter)).not.toContain(postId);
      // Not even for the member who wrote it — the community page owns that.
      expect(await globalFeedIds(member.token, filter)).not.toContain(postId);
      expect(await globalFeedIds(owner.token, filter)).not.toContain(postId);
    }
  });

  it("keeps a private community's post out of `following` too", async () => {
    const { postId, member } = await postIn("private");
    const follower = await createUser();

    await request(app)
      .post(`/api/v1/users/${member.username}/follow`)
      .set(...bearer(follower.token))
      .expect(201);

    expect(await globalFeedIds(follower.token, "following")).not.toContain(postId);
  });

  it("keeps a private community's post off the author's public profile", async () => {
    const { postId, member } = await postIn("private");

    const profile = await request(app)
      .get(`/api/v1/users/${member.username}/posts`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect((profile.body.data.items as { id: string }[]).map((p) => p.id)).not.toContain(
      postId,
    );
  });

  it("404s a private community's post to a non-member, and serves it to a member", async () => {
    const { postId, member } = await postIn("private");

    await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(outsider.token))
      .expect(404);
    await request(app).get(`/api/v1/posts/${postId}`).expect(404);

    await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(member.token))
      .expect(200);
  });

  it("reads an unlisted community's post by id but never enumerates it", async () => {
    const { postId, id } = await postIn("unlisted");

    await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(outsider.token))
      .expect(200);

    expect(await globalFeedIds(outsider.token)).not.toContain(postId);

    // …and the community itself is absent from discovery.
    const discovery = await request(app)
      .get(BASE)
      .query({ limit: 100 })
      .set(...bearer(outsider.token))
      .expect(200);
    expect(
      (discovery.body.data.items as { id: string }[]).map((c) => c.id),
    ).not.toContain(id);
  });

  it("hides a deleted community's posts from everyone, author included", async () => {
    const { slug, postId, member } = await postIn("public");

    await request(app)
      .delete(`${BASE}/${slug}`)
      .set(...bearer(owner.token))
      .expect(200);

    // Not converted into ordinary posts (decision J13).
    for (const token of [undefined, outsider.token, member.token, owner.token]) {
      const req = request(app).get(`/api/v1/posts/${postId}`);
      if (token) req.set(...bearer(token));
      await req.expect(404);
    }

    expect(await globalFeedIds()).not.toContain(postId);
    expect(await globalFeedIds(member.token)).not.toContain(postId);
  });

  it("lets blocking outrank community membership", async () => {
    const community = await makeCommunity(owner, { visibility: "public" });
    const blocked = await createUser();
    await seat(community.slug, owner, blocked, "moderator");

    const created = await request(app)
      .post(`${BASE}/${community.slug}/posts`)
      .set(...bearer(owner.token))
      .send({ content: "Blocked should not see this" })
      .expect(201);
    const postId = created.body.data.post.id as string;

    await request(app)
      .post(`/api/v1/users/${blocked.username}/block`)
      .set(...bearer(owner.token))
      .expect(201);

    await request(app)
      .get(`/api/v1/posts/${postId}`)
      .set(...bearer(blocked.token))
      .expect(404);
    expect(await globalFeedIds(blocked.token)).not.toContain(postId);
    // …and the community itself becomes a 404 despite the moderator role.
    await request(app)
      .get(`${BASE}/${community.slug}`)
      .set(...bearer(blocked.token))
      .expect(404);
  });

  it("leaves ordinary non-community posts behaving exactly as in Phase 6", async () => {
    const created = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(owner.token))
      .send({ content: "An ordinary post" })
      .expect(201);
    const postId = created.body.data.post.id as string;

    expect(await globalFeedIds()).toContain(postId);
    await request(app).get(`/api/v1/posts/${postId}`).expect(200);

    const priv = await request(app)
      .post("/api/v1/posts")
      .set(...bearer(owner.token))
      .send({ content: "Ordinary private", visibility: "private" })
      .expect(201);
    const privId = priv.body.data.post.id as string;

    await request(app)
      .get(`/api/v1/posts/${privId}`)
      .set(...bearer(outsider.token))
      .expect(404);
    expect(await globalFeedIds(outsider.token)).not.toContain(privId);
    expect(await globalFeedIds(owner.token)).toContain(privId);
  });
});
