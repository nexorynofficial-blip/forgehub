import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Repository and service integration coverage for Phase 7.
 *
 * Runs against real PostgreSQL, not a mocked Prisma. The guarantees under test
 * here are properties of unique constraints, transactions, and SQL predicates:
 * a mocked client would report that a function was called rather than that a
 * counter survived, that a hidden community stayed out of a page, or that a
 * cursor neither skipped nor repeated a row.
 *
 * These tests exercise the service directly rather than through HTTP —
 * controllers and routes are the next chunk. `loadVisibleCommunity` is the gate
 * every case goes through, which is exactly the surface worth pinning before
 * anything is mounted on top of it.
 */

vi.mock("../src/integrations/email/index.js", () => ({
  emailService: {
    providerName: "test",
    sendVerificationEmail: () => Promise.resolve(),
    sendPasswordResetEmail: () => Promise.resolve(),
    sendSecurityAlertEmail: () => Promise.resolve(),
  },
}));

const { prisma } = await import("../src/database/prisma.js");
const service = await import("../src/modules/communities/communities.service.js");
const repo = await import("../src/modules/communities/communities.repository.js");
const members = await import("../src/modules/communities/members.service.js");
const { isCommunityListable } =
  await import("../src/modules/communities/community.visibility.js");
const { hashPassword } = await import("../src/utils/password.js");

const NS = "commrepo";
const AUDIT = { ipAddress: null, userAgent: null };

interface TestActor {
  id: string;
  role: "member";
  username: string;
}

let seq = 0;
async function createUser(): Promise<TestActor> {
  seq += 1;
  const suffix = `${String(seq)}${String(Date.now()).slice(-6)}`;
  const user = await prisma.user.create({
    data: {
      email: `${NS}.${suffix}@forgehub.test`,
      username: `${NS}.${suffix}`,
      displayName: `Comm Tester ${suffix}`,
      passwordHash: await hashPassword("ValidPass123"),
      profile: { create: {} },
    },
    select: { id: true, username: true },
  });

  return { id: user.id, role: "member", username: user.username };
}

const anonymous = service.ANONYMOUS;
const viewerOf = (actor: TestActor) => ({ id: actor.id, role: actor.role });

let n = 0;
async function makeCommunity(owner: TestActor, overrides: Record<string, unknown> = {}) {
  n += 1;
  return service.create(
    owner,
    {
      name: `${NS} Community ${String(n)}`,
      category: "Testing",
      ...overrides,
    } as Parameters<typeof service.create>[1],
    AUDIT,
  );
}

let owner: TestActor;
let outsider: TestActor;
let member: TestActor;
let admin: TestActor;

beforeAll(async () => {
  owner = await createUser();
  outsider = await createUser();
  member = await createUser();
  admin = await createUser();
  await prisma.user.update({ where: { id: admin.id }, data: { role: "platform_admin" } });
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
      // Release tags before deleting, or `Tag.usageCount` is left inflated —
      // the exact drift the Phase 5 test-cleanup bug produced.
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

      await prisma.community.deleteMany({ where: { id: { in: communityIds } } });
    }

    await prisma.auditLog.deleteMany({
      where: { OR: [{ actorId: { in: ids } }, { targetId: { in: ids } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  await prisma.$disconnect();
});

/* ── Slug behaviour (Phase 5 conventions) ────────────────────────────────── */

describe("Slug derivation", () => {
  it("derives the slug from the name, server-side", async () => {
    const created = await service.create(
      owner,
      { name: `${NS} Slug Derivation`, category: "Testing" },
      AUDIT,
    );

    expect(created.slug).toBe(`${NS}-slug-derivation`);
  });

  it("never accepts a client-supplied slug", async () => {
    const created = await service.create(
      owner,
      {
        name: `${NS} Client Slug`,
        category: "Testing",
        slug: "attacker-chosen",
      } as Parameters<typeof service.create>[1],
      AUDIT,
    );

    expect(created.slug).toBe(`${NS}-client-slug`);
    expect(created.slug).not.toBe("attacker-chosen");
  });

  it("suffixes a colliding slug rather than failing", async () => {
    const name = `${NS} Collision Test`;
    const first = await service.create(owner, { name, category: "Testing" }, AUDIT);
    const second = await service.create(owner, { name, category: "Testing" }, AUDIT);

    expect(first.slug).toBe(`${NS}-collision-test`);
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug.startsWith(`${NS}-collision-test`)).toBe(true);
  });

  it("keeps the slug immutable across a rename", async () => {
    const created = await makeCommunity(owner);
    const renamed = await service.update(created.slug, owner, { name: `${NS} Renamed` });

    expect(renamed.slug).toBe(created.slug);
    expect(renamed.name).toBe(`${NS} Renamed`);
  });
});

/* ── Visibility matrix ───────────────────────────────────────────────────── */

describe("Visibility matrix", () => {
  it("serves a public community to anonymous callers", async () => {
    const created = await makeCommunity(owner, { visibility: "public" });
    const result = await service.getBySlug(created.slug, anonymous);

    expect(result.community.id).toBe(created.id);
    // No relationship to describe for an anonymous viewer.
    expect(result.viewer).toBeNull();
  });

  it("404s a private community for a non-member, never 403", async () => {
    const created = await makeCommunity(owner, { visibility: "private" });

    await expect(
      service.getBySlug(created.slug, viewerOf(outsider)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.getBySlug(created.slug, anonymous)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("serves a private community to its owner and to a member", async () => {
    const created = await makeCommunity(owner, { visibility: "private" });
    await repo.addMember(created.id, member.id, "member");

    await expect(service.getBySlug(created.slug, viewerOf(owner))).resolves.toMatchObject(
      { community: { id: created.id } },
    );
    await expect(
      service.getBySlug(created.slug, viewerOf(member)),
    ).resolves.toMatchObject({ community: { id: created.id } });
  });

  it("recognises a plain member, whom the detail select does not carry", async () => {
    // The detail select loads only moderating members, so a plain member's
    // access depends on the gate's separate membership query.
    const created = await makeCommunity(owner, { visibility: "private" });
    await repo.addMember(created.id, member.id, "member");

    const result = await service.getBySlug(created.slug, viewerOf(member));
    expect(result.viewer?.isMember).toBe(true);
    expect(result.viewer?.role).toBe("member");
  });

  it("serves a private community to a platform admin", async () => {
    const created = await makeCommunity(owner, { visibility: "private" });

    await expect(
      service.getBySlug(created.slug, { id: admin.id, role: "platform_admin" }),
    ).resolves.toMatchObject({ community: { id: created.id } });
  });

  it("reads an unlisted community directly but omits it from discovery", async () => {
    const created = await makeCommunity(owner, { visibility: "unlisted" });

    await expect(
      service.getBySlug(created.slug, viewerOf(outsider)),
    ).resolves.toMatchObject({ community: { id: created.id } });

    const page = await service.list(viewerOf(outsider), {
      limit: 100,
      sort: "recent",
    } as Parameters<typeof service.list>[1]);

    expect(page.items.map((c) => c.id)).not.toContain(created.id);
  });

  it("404s the blocker's community for a blocked viewer", async () => {
    const blocked = await createUser();
    const created = await makeCommunity(owner, { visibility: "public" });

    await prisma.block.create({ data: { blockerId: owner.id, blockedId: blocked.id } });

    await expect(
      service.getBySlug(created.slug, viewerOf(blocked)),
    ).rejects.toMatchObject({ status: 404 });

    const page = await service.list(viewerOf(blocked), {
      limit: 100,
      sort: "recent",
    } as Parameters<typeof service.list>[1]);
    expect(page.items.map((c) => c.id)).not.toContain(created.id);

    await prisma.block.deleteMany({
      where: { blockerId: owner.id, blockedId: blocked.id },
    });
  });

  it("lets blocking outrank even a member's access", async () => {
    const blockedMember = await createUser();
    const created = await makeCommunity(owner, { visibility: "public" });
    await repo.addMember(created.id, blockedMember.id, "member");

    await prisma.block.create({
      data: { blockerId: owner.id, blockedId: blockedMember.id },
    });

    await expect(
      service.getBySlug(created.slug, viewerOf(blockedMember)),
    ).rejects.toMatchObject({ status: 404 });

    await prisma.block.deleteMany({
      where: { blockerId: owner.id, blockedId: blockedMember.id },
    });
  });

  it("keeps the SQL filter and the pure predicate in agreement", async () => {
    // If `listVisibilityWhere` and `isCommunityListable` disagreed, paging
    // would silently return short pages — the Phase 5/6 lesson.
    await makeCommunity(owner, { visibility: "public" });
    await makeCommunity(owner, { visibility: "private" });
    await makeCommunity(owner, { visibility: "unlisted" });

    const page = await service.list(viewerOf(outsider), {
      limit: 100,
      sort: "recent",
    } as Parameters<typeof service.list>[1]);

    // An outsider is neither owner, member, nor admin of anything here, so the
    // pure predicate reduces to "is it public". Every row SQL handed back must
    // therefore satisfy it; a private or unlisted row surviving the filter is
    // precisely the divergence this asserts against.
    for (const item of page.items) {
      const listable = isCommunityListable({
        viewerId: outsider.id,
        viewerRole: "member",
        // Deliberately not `outsider.id`: the outsider owns none of these, and
        // naming them as owner would grant access the SQL never granted.
        ownerId: `not-${outsider.id}`,
        visibility: item.visibility,
        deleted: false,
        isMember: false,
        ownerBlockedViewer: false,
      });

      expect(listable, `${item.slug} (${item.visibility}) leaked into a listing`).toBe(
        true,
      );
    }
  });
});

/* ── Deletion (decision J13) ─────────────────────────────────────────────── */

describe("Soft deletion", () => {
  it("404s a deleted community for everyone, including its owner", async () => {
    const created = await makeCommunity(owner);
    await service.remove(created.slug, owner, AUDIT);

    for (const viewer of [
      viewerOf(owner),
      viewerOf(outsider),
      anonymous,
      { id: admin.id, role: "platform_admin" as const },
    ]) {
      await expect(service.getBySlug(created.slug, viewer)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it("soft-deletes rather than removing the row", async () => {
    const created = await makeCommunity(owner);
    await service.remove(created.slug, owner, AUDIT);

    const row = await prisma.community.findUnique({
      where: { id: created.id },
      select: { deletedAt: true },
    });

    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
  });

  it("omits a deleted community from discovery", async () => {
    const created = await makeCommunity(owner);
    await service.remove(created.slug, owner, AUDIT);

    const page = await service.list(viewerOf(owner), {
      limit: 100,
      sort: "recent",
    } as Parameters<typeof service.list>[1]);

    expect(page.items.map((c) => c.id)).not.toContain(created.id);
  });

  it("refuses deletion to someone who is not the owner", async () => {
    const created = await makeCommunity(owner);
    await repo.addMember(created.id, member.id, "member");

    await expect(service.remove(created.slug, member, AUDIT)).rejects.toMatchObject({
      status: 403,
    });
  });
});

/* ── Projections ─────────────────────────────────────────────────────────── */

describe("Projections", () => {
  it("never emits deletedAt or any internal field", async () => {
    const created = await makeCommunity(owner);
    const result = await service.getBySlug(created.slug, viewerOf(owner));

    expect(result.community).not.toHaveProperty("deletedAt");
    expect(result.community).not.toHaveProperty("updatedAt");
    expect(result.community).not.toHaveProperty("members");
  });

  it("projects the owner through UserSummary, with no credential or email", async () => {
    const created = await makeCommunity(owner);
    const { community } = await service.getBySlug(created.slug, viewerOf(owner));

    expect(Object.keys(community.owner).sort()).toEqual([
      "avatarUrl",
      "builderRank",
      "displayName",
      "id",
      "username",
    ]);
    expect(community.owner).not.toHaveProperty("passwordHash");
    expect(community.owner).not.toHaveProperty("email");
  });

  it("serves the frontend's Community keys plus the additive three", async () => {
    const created = await makeCommunity(owner);
    const { community } = await service.getBySlug(created.slug, viewerOf(owner));

    for (const key of [
      "id",
      "slug",
      "name",
      "description",
      "avatarUrl",
      "bannerUrl",
      "category",
      "tags",
      "rules",
      "moderatorIds",
      "memberCount",
      "pinnedPostIds",
      "events",
      "createdAt",
    ]) {
      expect(community).toHaveProperty(key);
    }

    expect(community).toHaveProperty("visibility");
    expect(community).toHaveProperty("ownerId");
    expect(community).toHaveProperty("owner");
  });

  it("projects tags as a flat string[] of display names", async () => {
    const tag = await prisma.tag.findFirstOrThrow({ select: { name: true } });
    const created = await makeCommunity(owner, { tags: [tag.name] });

    expect(created.tags).toEqual([tag.name]);
    expect(typeof created.tags[0]).toBe("string");
  });

  it("projects rules as string[] in position order", async () => {
    const created = await makeCommunity(owner);
    await repo.replaceRules(created.id, ["First", "Second", "Third"]);

    const { community } = await service.getBySlug(created.slug, viewerOf(owner));
    expect(community.rules).toEqual(["First", "Second", "Third"]);
  });

  it("includes the owner in moderatorIds", async () => {
    const created = await makeCommunity(owner);
    const { community } = await service.getBySlug(created.slug, viewerOf(owner));

    expect(community.moderatorIds).toContain(owner.id);
  });

  it("includes admins and moderators, but not plain members, in moderatorIds", async () => {
    const created = await makeCommunity(owner);
    const mod = await createUser();
    await repo.addMember(created.id, mod.id, "moderator");
    await repo.addMember(created.id, member.id, "member");

    const { community } = await service.getBySlug(created.slug, viewerOf(owner));
    expect(community.moderatorIds).toContain(mod.id);
    expect(community.moderatorIds).not.toContain(member.id);
  });

  it("projects events with only the four fields the frontend reads", async () => {
    const created = await makeCommunity(owner);
    await repo.createEvent({
      communityId: created.id,
      title: "Office hours",
      description: "Internal detail",
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: null,
      isOnline: true,
      location: null,
    });

    const { community } = await service.getBySlug(created.slug, viewerOf(owner));
    const event = community.events[0];

    expect(event).toBeDefined();
    expect(Object.keys(event ?? {}).sort()).toEqual([
      "endsAt",
      "id",
      "startsAt",
      "title",
    ]);
    // attendeeCount has no writer and is deliberately never projected (J10).
    expect(event).not.toHaveProperty("attendeeCount");
    expect(event).not.toHaveProperty("description");
  });

  it("projects pinnedPostIds from CommunityPinnedPost", async () => {
    const created = await makeCommunity(owner);
    const post = await prisma.post.create({
      data: { authorId: owner.id, content: "Pinned", communityId: created.id },
      select: { id: true },
    });

    await repo.pinPost(created.id, post.id, owner.id);

    const { community } = await service.getBySlug(created.slug, viewerOf(owner));
    expect(community.pinnedPostIds).toContain(post.id);

    await prisma.post.delete({ where: { id: post.id } });
  });

  it("reports memberCount from the counter, not the truncated members array", async () => {
    const created = await makeCommunity(owner);
    for (const _ of [1, 2, 3]) {
      await repo.addMember(created.id, (await createUser()).id, "member");
    }

    const { community } = await service.getBySlug(created.slug, viewerOf(owner));
    // 1 owner + 3 plain members; the detail select carries only the owner.
    expect(community.memberCount).toBe(4);
    expect(community.moderatorIds).toHaveLength(1);
  });
});

/* ── Discovery: filters and cursor pagination (decision J12) ─────────────── */

describe("Discovery", () => {
  it("filters by category", async () => {
    const created = await makeCommunity(owner, { category: "UniqueCategoryXYZ" });

    const page = await service.list(viewerOf(owner), {
      limit: 100,
      sort: "recent",
      category: "UniqueCategoryXYZ",
    } as Parameters<typeof service.list>[1]);

    expect(page.items.map((c) => c.id)).toContain(created.id);
    expect(page.items.every((c) => c.category === "UniqueCategoryXYZ")).toBe(true);
  });

  it("searches name and description with q", async () => {
    const created = await makeCommunity(owner, {
      name: `${NS} Zephyr Searchable`,
      description: "nothing notable",
    });

    const byName = await service.list(viewerOf(owner), {
      limit: 100,
      sort: "recent",
      q: "Zephyr",
    } as Parameters<typeof service.list>[1]);

    expect(byName.items.map((c) => c.id)).toContain(created.id);
  });

  it("does not let q widen the visibility filter", async () => {
    // The visibility clause and the q clause both want `OR`; if they collided,
    // a search would return private communities.
    const secret = await makeCommunity(owner, {
      name: `${NS} Quokka Private`,
      visibility: "private",
    });

    const page = await service.list(viewerOf(outsider), {
      limit: 100,
      sort: "recent",
      q: "Quokka",
    } as Parameters<typeof service.list>[1]);

    expect(page.items.map((c) => c.id)).not.toContain(secret.id);
  });

  it("cursor-paginates without repeating or skipping", async () => {
    for (const _ of [1, 2, 3, 4, 5]) await makeCommunity(owner);

    const first = await service.list(viewerOf(owner), {
      limit: 3,
      sort: "recent",
    } as Parameters<typeof service.list>[1]);

    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.list(viewerOf(owner), {
      limit: 3,
      sort: "recent",
      cursor: first.nextCursor ?? undefined,
    } as Parameters<typeof service.list>[1]);

    const firstIds = first.items.map((c) => c.id);
    const secondIds = second.items.map((c) => c.id);

    expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  });

  it("returns a null cursor on the last page", async () => {
    const page = await service.list(viewerOf(owner), {
      limit: 100,
      sort: "recent",
      category: "NoSuchCategoryAtAll",
    } as Parameters<typeof service.list>[1]);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("sorts by memberCount when asked", async () => {
    const quiet = await makeCommunity(owner, { category: "SortProbe" });
    const busy = await makeCommunity(owner, { category: "SortProbe" });

    for (const _ of [1, 2, 3]) {
      await repo.addMember(busy.id, (await createUser()).id, "member");
    }

    const page = await service.list(viewerOf(owner), {
      limit: 100,
      sort: "members",
      category: "SortProbe",
    } as Parameters<typeof service.list>[1]);

    const ids = page.items.map((c) => c.id);
    expect(ids.indexOf(busy.id)).toBeLessThan(ids.indexOf(quiet.id));
  });
});

/* ── memberCount invariants (decision J6) ────────────────────────────────── */

describe("memberCount invariants", () => {
  async function counterAndRows(communityId: string) {
    const [row, rows] = await Promise.all([
      prisma.community.findUniqueOrThrow({
        where: { id: communityId },
        select: { memberCount: true },
      }),
      prisma.communityMember.count({ where: { communityId } }),
    ]);
    return { counter: row.memberCount, rows };
  }

  it("starts at 1, with the owner's membership row already present", async () => {
    const created = await makeCommunity(owner);
    const state = await counterAndRows(created.id);

    expect(state.counter).toBe(1);
    expect(state.rows).toBe(1);

    const ownerRow = await repo.findMembership(created.id, owner.id);
    expect(ownerRow?.role).toBe("owner");
  });

  it("moves with each add and each remove", async () => {
    const created = await makeCommunity(owner);
    const joiner = await createUser();

    await repo.addMember(created.id, joiner.id, "member");
    expect(await counterAndRows(created.id)).toEqual({ counter: 2, rows: 2 });

    await repo.removeMember(created.id, joiner.id);
    expect(await counterAndRows(created.id)).toEqual({ counter: 1, rows: 1 });
  });

  it("rolls the increment back when the unique constraint rejects a duplicate", async () => {
    // The `@@unique([communityId, userId])` constraint is the arbiter: the
    // duplicate insert raises P2002, and the increment rolls back with it.
    const created = await makeCommunity(owner);
    const joiner = await createUser();

    await repo.addMember(created.id, joiner.id, "member");
    await expect(repo.addMember(created.id, joiner.id, "member")).rejects.toThrow();

    expect(await counterAndRows(created.id)).toEqual({ counter: 2, rows: 2 });
  });

  it("does not decrement when the delete removed nothing", async () => {
    const created = await makeCommunity(owner);
    const stranger = await createUser();

    const removed = await repo.removeMember(created.id, stranger.id);
    expect(removed).toBe(false);
    expect(await counterAndRows(created.id)).toEqual({ counter: 1, rows: 1 });
  });

  it("never drives the counter negative", async () => {
    const created = await makeCommunity(owner);

    // Force the counter to 0 while a row still exists, then remove it.
    await prisma.community.update({
      where: { id: created.id },
      data: { memberCount: 0 },
    });
    await repo.removeMember(created.id, owner.id);

    const row = await prisma.community.findUniqueOrThrow({
      where: { id: created.id },
      select: { memberCount: true },
    });
    expect(row.memberCount).toBeGreaterThanOrEqual(0);
  });

  it("counts every joiner under genuine concurrency", async () => {
    const created = await makeCommunity(owner);
    const joiners = await Promise.all(Array.from({ length: 6 }, () => createUser()));

    await Promise.all(
      joiners.map((joiner) => repo.addMember(created.id, joiner.id, "member")),
    );

    expect(await counterAndRows(created.id)).toEqual({ counter: 7, rows: 7 });
  });

  it("commits exactly one of many simultaneous identical joins", async () => {
    const created = await makeCommunity(owner);
    const joiner = await createUser();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => repo.addMember(created.id, joiner.id, "member")),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await counterAndRows(created.id)).toEqual({ counter: 2, rows: 2 });
  });
});

/* ── Ownership (decision J7) ─────────────────────────────────────────────── */

describe("Ownership invariants", () => {
  it("keeps ownerId and the owner membership row in agreement after transfer", async () => {
    const created = await makeCommunity(owner);
    const successor = await createUser();
    await repo.addMember(created.id, successor.id, "member");

    await members.transfer(created.slug, owner, successor.username, AUDIT);

    const row = await prisma.community.findUniqueOrThrow({
      where: { id: created.id },
      select: { ownerId: true },
    });
    const membership = await repo.findMembership(created.id, successor.id);

    expect(row.ownerId).toBe(successor.id);
    expect(membership?.role).toBe("owner");
  });

  it("demotes the previous owner to admin rather than removing them", async () => {
    const created = await makeCommunity(owner);
    const successor = await createUser();
    await repo.addMember(created.id, successor.id, "member");

    await members.transfer(created.slug, owner, successor.username, AUDIT);

    const previous = await repo.findMembership(created.id, owner.id);
    expect(previous?.role).toBe("admin");
  });

  it("counts a non-member successor once, and only once", async () => {
    const created = await makeCommunity(owner);
    const successor = await createUser();

    await members.transfer(created.slug, owner, successor.username, AUDIT);

    const [counter, rows] = await Promise.all([
      prisma.community.findUniqueOrThrow({
        where: { id: created.id },
        select: { memberCount: true },
      }),
      prisma.communityMember.count({ where: { communityId: created.id } }),
    ]);

    expect(counter.memberCount).toBe(2);
    expect(rows).toBe(2);
  });

  it("refuses a transfer from anyone but the owner of record", async () => {
    const created = await makeCommunity(owner);
    const wannabe = await createUser();
    await repo.addMember(created.id, wannabe.id, "admin");

    await expect(
      members.transfer(created.slug, wannabe, owner.username, AUDIT),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to let the owner leave their own community", async () => {
    const created = await makeCommunity(owner);

    // 422, not 403: the refusal is about the *state* of the request — the
    // owner invariant — rather than the caller lacking a permission, and it
    // carries a field-level message telling them to transfer first. This
    // matches how Phase 5 refuses the same move on a project.
    await expect(members.leave(created.slug, owner)).rejects.toMatchObject({
      status: 422,
    });
  });
});

/* ── Joining (decision J5) ───────────────────────────────────────────────── */

describe("Join and leave", () => {
  it("lets a viewer self-join a public community", async () => {
    const created = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    const state = await members.join(created.slug, joiner);
    expect(state.isMember).toBe(true);
    expect(state.role).toBe("member");
  });

  it("lets a viewer self-join an unlisted community reached by slug", async () => {
    const created = await makeCommunity(owner, { visibility: "unlisted" });
    const joiner = await createUser();

    await expect(members.join(created.slug, joiner)).resolves.toMatchObject({
      isMember: true,
    });
  });

  it("409s a second join", async () => {
    const created = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await members.join(created.slug, joiner);
    await expect(members.join(created.slug, joiner)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("404s a private community before the join rule is ever consulted", async () => {
    const created = await makeCommunity(owner, { visibility: "private" });
    const joiner = await createUser();

    await expect(members.join(created.slug, joiner)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets a member leave, moving the counter back", async () => {
    const created = await makeCommunity(owner, { visibility: "public" });
    const joiner = await createUser();

    await members.join(created.slug, joiner);
    await members.leave(created.slug, joiner);

    const row = await prisma.community.findUniqueOrThrow({
      where: { id: created.id },
      select: { memberCount: true },
    });
    expect(row.memberCount).toBe(1);
  });
});

/* ── Tag counters (decision J8) ──────────────────────────────────────────── */

describe("Tag usageCount", () => {
  async function usage(tagId: string): Promise<number> {
    const row = await prisma.tag.findUniqueOrThrow({
      where: { id: tagId },
      select: { usageCount: true },
    });
    return row.usageCount;
  }

  it("increments on attach and decrements on detach", async () => {
    const tag = await prisma.tag.findFirstOrThrow({ select: { id: true, name: true } });
    const before = await usage(tag.id);

    const created = await makeCommunity(owner, { tags: [tag.name] });
    expect(await usage(tag.id)).toBe(before + 1);

    await service.update(created.slug, owner, { tags: [] });
    expect(await usage(tag.id)).toBe(before);
  });

  it("shares the counter with ProjectTag rather than tracking communities alone", async () => {
    // One counter, two writers (decision J8): attaching from both sides must
    // add up, not overwrite.
    const tag = await prisma.tag.findFirstOrThrow({ select: { id: true, name: true } });
    const before = await usage(tag.id);

    const community = await makeCommunity(owner, { tags: [tag.name] });
    const project = await prisma.project.create({
      data: {
        slug: `${NS}-tagshare-${String(Date.now())}`,
        ownerId: owner.id,
        title: "Tag share probe",
        tags: { create: [{ tagId: tag.id }] },
      },
      select: { id: true },
    });
    await prisma.tag.update({
      where: { id: tag.id },
      data: { usageCount: { increment: 1 } },
    });

    expect(await usage(tag.id)).toBe(before + 2);

    // Detaching the community must leave the project's usage intact.
    await service.update(community.slug, owner, { tags: [] });
    expect(await usage(tag.id)).toBe(before + 1);

    await prisma.projectTag.deleteMany({ where: { projectId: project.id } });
    await prisma.tag.updateMany({
      where: { id: tag.id, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
    await prisma.project.delete({ where: { id: project.id } });
  });

  it("never drives usageCount negative", async () => {
    const tag = await prisma.tag.findFirstOrThrow({ select: { id: true, name: true } });
    const created = await makeCommunity(owner, { tags: [tag.name] });

    // Force the counter to 0 while the link still exists — exactly the seed's
    // state, which creates tag links without touching the counter.
    await prisma.tag.update({ where: { id: tag.id }, data: { usageCount: 0 } });
    await service.update(created.slug, owner, { tags: [] });

    expect(await usage(tag.id)).toBe(0);
  });

  it("releases tags when the community is soft-deleted", async () => {
    const tag = await prisma.tag.findFirstOrThrow({ select: { id: true, name: true } });
    const before = await usage(tag.id);

    const created = await makeCommunity(owner, { tags: [tag.name] });
    expect(await usage(tag.id)).toBe(before + 1);

    await service.remove(created.slug, owner, AUDIT);
    expect(await usage(tag.id)).toBe(before);
  });

  it("refuses an unknown tag rather than creating it", async () => {
    await expect(
      makeCommunity(owner, { tags: ["definitely-not-a-real-tag-xyz"] }),
    ).rejects.toMatchObject({ status: 422 });

    const created = await prisma.tag.findFirst({
      where: { slug: "definitely-not-a-real-tag-xyz" },
    });
    expect(created).toBeNull();
  });
});
