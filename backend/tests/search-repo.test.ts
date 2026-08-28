import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/database/prisma.js";
import {
  isCommunityDiscoverable,
  isPostDiscoverable,
  isProjectDiscoverable,
  isUserDiscoverable,
} from "../src/modules/search/search.access.js";
import * as repo from "../src/modules/search/search.repository.js";

/**
 * Search persistence against a real PostgreSQL (PRD §15, ARCHITECTURE §24).
 *
 * These are the claims a unit test cannot make, because they are properties of
 * the query rather than of a function:
 *
 *   1. **The `where` clauses agree with the pure predicates.**
 *      `search.access.ts` mirrors the SQL, and the mirror is only worth having
 *      if the two are pinned together on real rows. Every visibility test
 *      below asserts both — the row's presence in the result set *and* the
 *      predicate's verdict — so a divergence fails here rather than shipping.
 *   2. **Hidden rows do not reach `total`.** Filtering after the fetch would
 *      return short pages and count rows the viewer may not see; only a real
 *      `COUNT` under the real `where` can prove it does not.
 *   3. **Only the intended columns are matched.**
 *   4. **Offset paging is stable**, which needs a deterministic `ORDER BY` and
 *      more rows than fit on a page.
 *
 * Rows are created directly rather than over HTTP: the subject is the data
 * layer, and routing every fixture through Argon2 would make hashing the
 * dominant cost of the suite.
 */

const NS = "searchrepo";
/** Unique per run so concurrent suites cannot match each other's fixtures. */
const TOKEN = `zqx${String(Date.now() % 100000)}`;

const PAGE = { skip: 0, take: 50, sort: "recent" } as const;

let counter = 0;

interface Fixture {
  publicUser: string;
  followersOnlyUser: string;
  blockerUser: string;
  viewer: string;
  outsider: string;
}

const users: Fixture = {
  publicUser: "",
  followersOnlyUser: "",
  blockerUser: "",
  viewer: "",
  outsider: "",
};

async function makeUser(
  handle: string,
  visibility: "public" | "followers" = "public",
): Promise<string> {
  counter += 1;
  const user = await prisma.user.create({
    data: {
      username: `${NS}${handle}${String(counter)}${String(Date.now() % 100000)}`,
      email: `${NS}.${handle}.${String(counter)}.${String(Date.now())}@forgehub.test`,
      passwordHash: "not-a-real-hash",
      // The token goes in the display name so a user search can find the
      // fixture set without depending on username generation.
      displayName: `${TOKEN} ${handle}`,
      profile: { create: { visibility, bio: `${TOKEN} bio` } },
    },
    select: { id: true },
  });
  return user.id;
}

async function makeProject(
  ownerId: string,
  visibility: "public" | "private" | "unlisted",
  label: string,
): Promise<string> {
  counter += 1;
  const project = await prisma.project.create({
    data: {
      slug: `${NS}-${label}-${String(counter)}-${String(Date.now() % 100000)}`,
      ownerId,
      title: `${TOKEN} ${label}`,
      description: `A ${label} project.`,
      visibility,
    },
    select: { id: true },
  });
  return project.id;
}

async function makeCommunity(
  ownerId: string,
  visibility: "public" | "private" | "unlisted",
  label: string,
): Promise<string> {
  counter += 1;
  const community = await prisma.community.create({
    data: {
      slug: `${NS}-${label}-${String(counter)}-${String(Date.now() % 100000)}`,
      ownerId,
      name: `${TOKEN} ${label}`,
      description: `A ${label} community.`,
      category: "Design",
      visibility,
    },
    select: { id: true },
  });
  return community.id;
}

async function makePost(
  authorId: string,
  visibility: "public" | "private" | "unlisted",
  label: string,
  communityId?: string,
): Promise<string> {
  const post = await prisma.post.create({
    data: {
      authorId,
      content: `${TOKEN} ${label} post body`,
      visibility,
      ...(communityId !== undefined ? { communityId } : {}),
    },
    select: { id: true },
  });
  return post.id;
}

function ids(rows: { id: string }[]): string[] {
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  users.publicUser = await makeUser("pub");
  users.followersOnlyUser = await makeUser("foll", "followers");
  users.blockerUser = await makeUser("blocker");
  users.viewer = await makeUser("viewer");
  users.outsider = await makeUser("outsider");

  await prisma.block.create({
    data: { blockerId: users.blockerUser, blockedId: users.viewer },
  });
}, 60_000);

afterAll(async () => {
  const rows = await prisma.user.findMany({
    where: { email: { startsWith: NS } },
    select: { id: true },
  });
  const userIds = rows.map((row) => row.id);

  if (userIds.length > 0) {
    await prisma.post.deleteMany({ where: { authorId: { in: userIds } } });
    await prisma.project.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.community.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.block.deleteMany({
      where: { OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }] },
    });
    await prisma.follow.deleteMany({
      where: { OR: [{ followerId: { in: userIds } }, { followingId: { in: userIds } }] },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  await prisma.tag.deleteMany({ where: { slug: { startsWith: NS } } });
  await prisma.$disconnect();
});

/* ── Users ───────────────────────────────────────────────────────────────── */

describe("searchUsers", () => {
  it("finds a public profile for an anonymous viewer", async () => {
    const result = await repo.searchUsers(TOKEN, null, PAGE);
    expect(ids(result.rows)).toContain(users.publicUser);
  });

  it("hides a followers-only profile from an anonymous viewer, in rows and in total", async () => {
    const result = await repo.searchUsers(TOKEN, null, PAGE);

    expect(ids(result.rows)).not.toContain(users.followersOnlyUser);
    // The count is taken under the same `where`, so a hidden row cannot be
    // inferred from a total that exceeds the page.
    expect(result.total).toBe(result.rows.length);
    expect(
      isUserDiscoverable({
        viewerId: null,
        targetId: users.followersOnlyUser,
        deleted: false,
        targetVisibility: "followers",
        isFollowing: false,
        targetBlockedViewer: false,
      }),
    ).toBe(false);
  });

  it("shows a followers-only profile once the viewer follows them", async () => {
    const follower = await makeUser("follows");
    const before = await repo.searchUsers(TOKEN, follower, PAGE);
    expect(ids(before.rows)).not.toContain(users.followersOnlyUser);

    await prisma.follow.create({
      data: { followerId: follower, followingId: users.followersOnlyUser },
    });

    const after = await repo.searchUsers(TOKEN, follower, PAGE);
    expect(ids(after.rows)).toContain(users.followersOnlyUser);
    expect(after.total).toBe(before.total + 1);
  });

  it("shows you your own followers-only profile", async () => {
    const result = await repo.searchUsers(TOKEN, users.followersOnlyUser, PAGE);
    expect(ids(result.rows)).toContain(users.followersOnlyUser);
  });

  it("hides a user who blocked the viewer", async () => {
    const result = await repo.searchUsers(TOKEN, users.viewer, PAGE);

    expect(ids(result.rows)).not.toContain(users.blockerUser);
    expect(
      isUserDiscoverable({
        viewerId: users.viewer,
        targetId: users.blockerUser,
        deleted: false,
        targetVisibility: "public",
        isFollowing: false,
        targetBlockedViewer: true,
      }),
    ).toBe(false);
  });

  it("still shows the blocker to everyone else", async () => {
    const result = await repo.searchUsers(TOKEN, users.outsider, PAGE);
    expect(ids(result.rows)).toContain(users.blockerUser);
  });

  it("finds a user with no profile row at all", async () => {
    // A freshly registered account has no `Profile`; the schema default is
    // public, so treating the absence as hidden would make every new account
    // undiscoverable until it opened its settings.
    counter += 1;
    const bare = await prisma.user.create({
      data: {
        username: `${NS}bare${String(counter)}${String(Date.now() % 100000)}`,
        email: `${NS}.bare.${String(counter)}.${String(Date.now())}@forgehub.test`,
        passwordHash: "not-a-real-hash",
        displayName: `${TOKEN} bare`,
      },
      select: { id: true },
    });

    const result = await repo.searchUsers(TOKEN, null, PAGE);
    expect(ids(result.rows)).toContain(bare.id);
  });

  it("excludes a soft-deleted account", async () => {
    const doomed = await makeUser("doomed");
    expect(ids((await repo.searchUsers(TOKEN, null, PAGE)).rows)).toContain(doomed);

    await prisma.user.update({ where: { id: doomed }, data: { deletedAt: new Date() } });

    expect(ids((await repo.searchUsers(TOKEN, null, PAGE)).rows)).not.toContain(doomed);
  });

  it("matches username and displayName, and nothing else", async () => {
    counter += 1;
    const marker = `bio${String(Date.now() % 100000)}`;
    const hidden = await prisma.user.create({
      data: {
        username: `${NS}nomatch${String(counter)}${String(Date.now() % 100000)}`,
        email: `${NS}.nomatch.${String(counter)}.${String(Date.now())}@forgehub.test`,
        passwordHash: "not-a-real-hash",
        displayName: "Nothing In Particular",
        profile: { create: { bio: marker } },
      },
      select: { id: true, username: true },
    });

    // The bio contains the term, but bios are projected and not matched.
    expect((await repo.searchUsers(marker, null, PAGE)).total).toBe(0);
    // The username does match.
    const byUsername = await repo.searchUsers(hidden.username, null, PAGE);
    expect(ids(byUsername.rows)).toContain(hidden.id);
  });

  it("never selects email, role, or status", async () => {
    const result = await repo.searchUsers(TOKEN, null, PAGE);
    const row = result.rows[0];

    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("email");
    expect(row).not.toHaveProperty("role");
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("passwordHash");
  });
});

/* ── Projects ────────────────────────────────────────────────────────────── */

describe("searchProjects", () => {
  it("finds a public project anonymously and hides private and unlisted", async () => {
    const owner = await makeUser("powner");
    const isPublic = await makeProject(owner, "public", "openproj");
    const isPrivate = await makeProject(owner, "private", "privproj");
    const isUnlisted = await makeProject(owner, "unlisted", "unlistproj");

    const result = await repo.searchProjects(TOKEN, null, PAGE);
    const found = ids(result.rows);

    expect(found).toContain(isPublic);
    expect(found).not.toContain(isPrivate);
    // "Reachable by link, not by listing" — a search result is a listing.
    expect(found).not.toContain(isUnlisted);
    expect(result.total).toBe(result.rows.length);
  });

  it("shows an owner their own private and unlisted projects", async () => {
    const owner = await makeUser("powner2");
    const isPrivate = await makeProject(owner, "private", "mine");
    const isUnlisted = await makeProject(owner, "unlisted", "minetoo");

    const found = ids((await repo.searchProjects(TOKEN, owner, PAGE)).rows);
    expect(found).toContain(isPrivate);
    expect(found).toContain(isUnlisted);
  });

  it("shows a collaborator a private project, and a stranger nothing", async () => {
    const owner = await makeUser("powner3");
    const member = await makeUser("pmember");
    const stranger = await makeUser("pstranger");
    const projectId = await makeProject(owner, "private", "teamproj");

    await prisma.projectMember.create({ data: { projectId, userId: member } });

    expect(ids((await repo.searchProjects(TOKEN, member, PAGE)).rows)).toContain(
      projectId,
    );
    expect(ids((await repo.searchProjects(TOKEN, stranger, PAGE)).rows)).not.toContain(
      projectId,
    );

    // And the mirror agrees on both.
    const base = {
      ownerId: owner,
      deleted: false,
      visibility: "private" as const,
      ownerBlockedViewer: false,
    };
    expect(isProjectDiscoverable({ ...base, viewerId: member, isMember: true })).toBe(
      true,
    );
    expect(isProjectDiscoverable({ ...base, viewerId: stranger, isMember: false })).toBe(
      false,
    );
  });

  it("hides a project whose owner blocked the viewer", async () => {
    const owner = await makeUser("pblocker");
    const blocked = await makeUser("pblocked");
    const projectId = await makeProject(owner, "public", "blockedproj");
    await prisma.block.create({ data: { blockerId: owner, blockedId: blocked } });

    expect(ids((await repo.searchProjects(TOKEN, blocked, PAGE)).rows)).not.toContain(
      projectId,
    );
    expect(ids((await repo.searchProjects(TOKEN, null, PAGE)).rows)).toContain(projectId);
  });

  it("excludes a soft-deleted project", async () => {
    const owner = await makeUser("pdel");
    const projectId = await makeProject(owner, "public", "goneproj");
    await prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date() },
    });

    expect(ids((await repo.searchProjects(TOKEN, owner, PAGE)).rows)).not.toContain(
      projectId,
    );
  });

  it("matches title and description", async () => {
    const owner = await makeUser("pmatch");
    counter += 1;
    const marker = `desc${String(Date.now() % 100000)}`;
    const project = await prisma.project.create({
      data: {
        slug: `${NS}-descmatch-${String(counter)}-${String(Date.now() % 100000)}`,
        ownerId: owner,
        title: "Unremarkable",
        description: `Something about ${marker}.`,
        visibility: "public",
      },
      select: { id: true },
    });

    expect(ids((await repo.searchProjects(marker, null, PAGE)).rows)).toContain(
      project.id,
    );
  });
});

/* ── Communities ─────────────────────────────────────────────────────────── */

describe("searchCommunities", () => {
  it("finds a public community and hides private and unlisted", async () => {
    const owner = await makeUser("cowner");
    const isPublic = await makeCommunity(owner, "public", "opencomm");
    const isPrivate = await makeCommunity(owner, "private", "privcomm");
    const isUnlisted = await makeCommunity(owner, "unlisted", "unlistcomm");

    const found = ids((await repo.searchCommunities(TOKEN, null, PAGE)).rows);
    expect(found).toContain(isPublic);
    expect(found).not.toContain(isPrivate);
    expect(found).not.toContain(isUnlisted);
  });

  it("shows a member their private community", async () => {
    const owner = await makeUser("cowner2");
    const member = await makeUser("cmember");
    const communityId = await makeCommunity(owner, "private", "memcomm");
    await prisma.communityMember.create({ data: { communityId, userId: member } });

    expect(ids((await repo.searchCommunities(TOKEN, member, PAGE)).rows)).toContain(
      communityId,
    );
    expect(
      isCommunityDiscoverable({
        viewerId: member,
        ownerId: owner,
        deleted: false,
        visibility: "private",
        isMember: true,
        ownerBlockedViewer: false,
      }),
    ).toBe(true);
  });

  it("hides a community whose owner blocked the viewer", async () => {
    const owner = await makeUser("cblocker");
    const blocked = await makeUser("cblocked");
    const communityId = await makeCommunity(owner, "public", "blockedcomm");
    await prisma.block.create({ data: { blockerId: owner, blockedId: blocked } });

    expect(ids((await repo.searchCommunities(TOKEN, blocked, PAGE)).rows)).not.toContain(
      communityId,
    );
  });

  it("excludes a soft-deleted community", async () => {
    const owner = await makeUser("cdel");
    const communityId = await makeCommunity(owner, "public", "gonecomm");
    await prisma.community.update({
      where: { id: communityId },
      data: { deletedAt: new Date() },
    });

    expect(ids((await repo.searchCommunities(TOKEN, owner, PAGE)).rows)).not.toContain(
      communityId,
    );
  });
});

/* ── Posts ───────────────────────────────────────────────────────────────── */

describe("searchPosts", () => {
  it("finds a public standalone post and hides non-public ones", async () => {
    const author = await makeUser("pauthor");
    const isPublic = await makePost(author, "public", "open");
    const isPrivate = await makePost(author, "private", "priv");

    const found = ids((await repo.searchPosts(TOKEN, null, PAGE)).rows);
    expect(found).toContain(isPublic);
    expect(found).not.toContain(isPrivate);
  });

  it("shows an author their own private post", async () => {
    const author = await makeUser("pauthor2");
    const isPrivate = await makePost(author, "private", "mine");

    expect(ids((await repo.searchPosts(TOKEN, author, PAGE)).rows)).toContain(isPrivate);
  });

  it("hides a public post inside a private community, even from a member", async () => {
    // The Phase 6 feed decision: a member reads private-community posts on the
    // community page, which owns its own scoped listing.
    const owner = await makeUser("scowner");
    const member = await makeUser("scmember");
    const communityId = await makeCommunity(owner, "private", "hiddencomm");
    await prisma.communityMember.create({ data: { communityId, userId: member } });
    const postId = await makePost(owner, "public", "inprivate", communityId);

    for (const viewer of [null, member, owner]) {
      expect(
        ids((await repo.searchPosts(TOKEN, viewer, PAGE)).rows),
        String(viewer),
      ).not.toContain(postId);
    }

    expect(
      isPostDiscoverable({
        viewerId: member,
        authorId: owner,
        deleted: false,
        visibility: "public",
        communityVisibility: "private",
        communityDeleted: false,
        authorBlockedViewer: false,
      }),
    ).toBe(false);
  });

  it("finds a public post inside a public community", async () => {
    const owner = await makeUser("scowner2");
    const communityId = await makeCommunity(owner, "public", "opencomm2");
    const postId = await makePost(owner, "public", "inpublic", communityId);

    expect(ids((await repo.searchPosts(TOKEN, null, PAGE)).rows)).toContain(postId);
  });

  it("hides a post whose author blocked the viewer", async () => {
    const author = await makeUser("sblocker");
    const blocked = await makeUser("sblocked");
    const postId = await makePost(author, "public", "blockedpost");
    await prisma.block.create({ data: { blockerId: author, blockedId: blocked } });

    expect(ids((await repo.searchPosts(TOKEN, blocked, PAGE)).rows)).not.toContain(
      postId,
    );
  });

  it("excludes a soft-deleted post", async () => {
    const author = await makeUser("sdel");
    const postId = await makePost(author, "public", "gonepost");
    await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });

    expect(ids((await repo.searchPosts(TOKEN, author, PAGE)).rows)).not.toContain(postId);
  });

  it("does not match codeContent", async () => {
    // PRD §15 says "Posts"; matching a second column is a product decision
    // this phase was not given.
    const author = await makeUser("scode");
    const marker = `codemark${String(Date.now() % 100000)}`;
    const post = await prisma.post.create({
      data: {
        authorId: author,
        type: "code",
        content: "A snippet.",
        codeContent: `const ${marker} = 1;`,
        visibility: "public",
      },
      select: { id: true },
    });

    expect((await repo.searchPosts(marker, null, PAGE)).total).toBe(0);
    expect(ids((await repo.searchPosts("A snippet", null, PAGE)).rows)).toContain(
      post.id,
    );
  });
});

/* ── Tags ────────────────────────────────────────────────────────────────── */

describe("searchTags", () => {
  it("matches both name and slug", async () => {
    const stamp = String(Date.now() % 100000);
    const byName = await prisma.tag.create({
      data: { slug: `${NS}-alpha-${stamp}`, name: `${TOKEN}Nameonly` },
      select: { id: true },
    });
    const bySlug = await prisma.tag.create({
      data: { slug: `${NS}-${TOKEN}slugonly-${stamp}`, name: "Unrelated Label" },
      select: { id: true },
    });

    const found = ids((await repo.searchTags(TOKEN, PAGE)).rows);
    expect(found).toContain(byName.id);
    expect(found).toContain(bySlug.id);
  });

  it("is visible to anonymous viewers — tags are curated taxonomy", async () => {
    // No viewer parameter exists on the function at all; this pins that.
    const result = await repo.searchTags(TOKEN, PAGE);
    expect(result.total).toBeGreaterThan(0);
  });

  it("orders by usageCount when asked for popular", async () => {
    const stamp = String(Date.now() % 100000);
    const marker = `pop${stamp}`;
    await prisma.tag.create({
      data: { slug: `${NS}-low-${stamp}`, name: `${marker} low`, usageCount: 1 },
    });
    await prisma.tag.create({
      data: { slug: `${NS}-high-${stamp}`, name: `${marker} high`, usageCount: 99 },
    });

    const result = await repo.searchTags(marker, { skip: 0, take: 10, sort: "popular" });
    expect(result.rows[0]?.usageCount).toBe(99);
  });
});

/* ── Paging and ordering ─────────────────────────────────────────────────── */

describe("offset paging", () => {
  it("returns disjoint pages that together cover the result set", async () => {
    const owner = await makeUser("pager");
    const marker = `page${String(Date.now() % 100000)}`;

    for (let index = 0; index < 5; index += 1) {
      counter += 1;
      await prisma.project.create({
        data: {
          slug: `${NS}-pager-${String(counter)}-${String(index)}-${String(Date.now() % 100000)}`,
          ownerId: owner,
          title: `${marker} project ${String(index)}`,
          description: "paging fixture",
          visibility: "public",
        },
      });
    }

    const first = await repo.searchProjects(marker, null, {
      skip: 0,
      take: 2,
      sort: "recent",
    });
    const second = await repo.searchProjects(marker, null, {
      skip: 2,
      take: 2,
      sort: "recent",
    });
    const third = await repo.searchProjects(marker, null, {
      skip: 4,
      take: 2,
      sort: "recent",
    });

    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(third.rows).toHaveLength(1);

    const seen = [...ids(first.rows), ...ids(second.rows), ...ids(third.rows)];
    // No duplicates across pages, which is what the `id DESC` tie-break buys:
    // these rows can share a `createdAt` millisecond.
    expect(new Set(seen).size).toBe(5);
  });

  it("reports a total larger than the page it returned", async () => {
    const owner = await makeUser("pager2");
    const marker = `tot${String(Date.now() % 100000)}`;
    for (let index = 0; index < 3; index += 1) {
      counter += 1;
      await prisma.project.create({
        data: {
          slug: `${NS}-tot-${String(counter)}-${String(index)}-${String(Date.now() % 100000)}`,
          ownerId: owner,
          title: `${marker} ${String(index)}`,
          description: "total fixture",
          visibility: "public",
        },
      });
    }

    const page = await repo.searchProjects(marker, null, {
      skip: 0,
      take: 1,
      sort: "recent",
    });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it("returns an empty page past the end without erroring", async () => {
    const result = await repo.searchProjects(TOKEN, null, {
      skip: 100_000,
      take: 10,
      sort: "recent",
    });
    expect(result.rows).toEqual([]);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});

/* ── Matching semantics ──────────────────────────────────────────────────── */

describe("matching", () => {
  it("is case-insensitive", async () => {
    const owner = await makeUser("caser");
    const marker = `MiXeD${String(Date.now() % 100000)}`;
    counter += 1;
    const project = await prisma.project.create({
      data: {
        slug: `${NS}-case-${String(counter)}-${String(Date.now() % 100000)}`,
        ownerId: owner,
        title: marker,
        description: "case fixture",
        visibility: "public",
      },
      select: { id: true },
    });

    for (const term of [marker.toLowerCase(), marker.toUpperCase(), marker]) {
      expect(ids((await repo.searchProjects(term, null, PAGE)).rows), term).toContain(
        project.id,
      );
    }
  });

  it("matches a substring, not only a prefix", async () => {
    const owner = await makeUser("substr");
    const marker = `mid${String(Date.now() % 100000)}`;
    counter += 1;
    const project = await prisma.project.create({
      data: {
        slug: `${NS}-substr-${String(counter)}-${String(Date.now() % 100000)}`,
        ownerId: owner,
        title: `Something ${marker} inside`,
        description: "substring fixture",
        visibility: "public",
      },
      select: { id: true },
    });

    expect(ids((await repo.searchProjects(marker, null, PAGE)).rows)).toContain(
      project.id,
    );
  });

  it("returns nothing for a term that matches nothing", async () => {
    const result = await repo.searchProjects(
      `nothingmatchesthis${String(Date.now())}`,
      null,
      PAGE,
    );
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("treats an underscore as a wildcard — a known, documented limitation", async () => {
    /*
     * Prisma's `contains` does not escape LIKE wildcards and offers no ESCAPE
     * clause, and ruling D2 forbids raw SQL. The effect is recorded here as a
     * test rather than only as a comment, so the day someone adds escaping
     * this fails and tells them the limitation is gone.
     *
     * It over-matches and never under-matches, which is why it is a precision
     * limitation and not a leak: the visibility clause is a separate `AND`.
     */
    const owner = await makeUser("wild");
    const stamp = String(Date.now() % 100000);
    counter += 1;
    const project = await prisma.project.create({
      data: {
        slug: `${NS}-wild-${String(counter)}-${stamp}`,
        ownerId: owner,
        title: `wildXcase${stamp}`,
        description: "wildcard fixture",
        visibility: "public",
      },
      select: { id: true },
    });

    // `_` matched a literal `X`, which a properly escaped LIKE would not do.
    const found = ids((await repo.searchProjects(`wild_case${stamp}`, null, PAGE)).rows);
    expect(found).toContain(project.id);
  });
});
