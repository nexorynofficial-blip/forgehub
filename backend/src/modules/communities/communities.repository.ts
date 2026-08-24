import { Prisma } from "@prisma/client";
import type { CommunityRole, UserRole, Visibility } from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { isAdminRole } from "../../middleware/role.middleware.js";
import { initialSlugFor, slugCandidate, slugify } from "../../utils/slug.js";
import { summarySelect } from "../users/users.repository.js";
import { MODERATING_ROLES } from "./community.access.js";
import type { CommunitySort } from "./communities.schema.js";

/**
 * The only layer that touches Prisma for communities and their children
 * (BACKEND_ARCHITECTURE.md §4).
 *
 * Two invariants live here rather than in the service, because they are only
 * safe at the database level:
 *
 *   - **Counters move with the row.** `Community.memberCount` and
 *     `Tag.usageCount` are denormalized (Phase 2), so every write pairs the row
 *     change with the counter change inside one transaction, using Prisma's
 *     `{ increment }` / `{ decrement }` — which compile to `SET x = x + 1`
 *     under the row lock, never a read-modify-write (decisions J6, J8).
 *   - **The owner's membership row is created with the community**, in the same
 *     transaction, so `Community.ownerId` and the `owner` `CommunityMember` row
 *     can never disagree (decision J7).
 *
 * `deletedAt` is *selected* by the detail query because the visibility gate
 * needs it, and deliberately never projected — see `community.view.ts`.
 */

/* ── Selects and row types ───────────────────────────────────────────────── */

/**
 * The full community payload.
 *
 * `members` is filtered to the **moderating roles only**. A community can hold
 * thousands of members and the detail view needs exactly two things from them:
 * `moderatorIds`, and the viewer's own role. The viewer's row is fetched
 * separately by the gate, so loading the full membership here would be an
 * unbounded fan-out for a list the response does not contain. This is the one
 * place the community detail select deliberately diverges from Phase 5's
 * project select, which could afford to embed every member.
 */
const communityDetailSelect = {
  id: true,
  slug: true,
  ownerId: true,
  name: true,
  description: true,
  avatarUrl: true,
  bannerUrl: true,
  category: true,
  visibility: true,
  memberCount: true,
  createdAt: true,
  updatedAt: true,
  /** Read for the visibility gate. Never projected into a response. */
  deletedAt: true,
  owner: { select: summarySelect },
  members: {
    where: { role: { in: [...MODERATING_ROLES] } },
    select: { userId: true, role: true, joinedAt: true },
    orderBy: { joinedAt: "asc" },
  },
  rules: {
    select: { id: true, content: true, position: true },
    // The frontend renders rules in array order with no sort of its own, so
    // the ordering contract lives in the response sequence (decision J11).
    orderBy: { position: "asc" },
  },
  events: {
    select: {
      id: true,
      title: true,
      description: true,
      startsAt: true,
      endsAt: true,
      isOnline: true,
      location: true,
    },
    orderBy: { startsAt: "asc" },
  },
  tags: { select: { tag: { select: { name: true, slug: true } } } },
  pinnedPosts: { select: { postId: true }, orderBy: { pinnedAt: "desc" } },
} satisfies Prisma.CommunitySelect;

export type CommunityDetailRow = Prisma.CommunityGetPayload<{
  select: typeof communityDetailSelect;
}>;

/** Backs the discovery grid; see `toCommunitySummary` for why it is narrower. */
const communitySummarySelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  avatarUrl: true,
  bannerUrl: true,
  category: true,
  visibility: true,
  memberCount: true,
  createdAt: true,
  tags: { select: { tag: { select: { name: true, slug: true } } } },
} satisfies Prisma.CommunitySelect;

export type CommunitySummaryRow = Prisma.CommunityGetPayload<{
  select: typeof communitySummarySelect;
}>;

/** The joined member shape, for the members endpoint. */
const memberSelect = {
  userId: true,
  role: true,
  joinedAt: true,
  user: { select: summarySelect },
} satisfies Prisma.CommunityMemberSelect;

export type CommunityMemberRow = Prisma.CommunityMemberGetPayload<{
  select: typeof memberSelect;
}>;

const eventSelect = {
  id: true,
  title: true,
  description: true,
  startsAt: true,
  endsAt: true,
  isOnline: true,
  location: true,
} satisfies Prisma.CommunityEventSelect;

export type CommunityEventRow = Prisma.CommunityEventGetPayload<{
  select: typeof eventSelect;
}>;

/* ── Viewer-scoped filtering ─────────────────────────────────────────────── */

export interface RepoViewer {
  id: string | null;
  role: UserRole | null;
}

/**
 * The listing filter, expressed in SQL rather than applied after the fact.
 *
 * This must agree with `isCommunityListable` in `community.visibility.ts`
 * branch for branch. Filtering in the database and *also* in a pure function is
 * not duplication for its own sake: the pure function is what the unit tests
 * pin the rules to, and this is what keeps a hidden community from ever
 * consuming a page slot. If the two disagreed, paging would silently return
 * short pages — the Phase 5 and Phase 6 lesson.
 *
 * The block clause uses `owner.blocksMade`: a community is invisible to a
 * viewer its owner has blocked, which is the Phase 4/5 rule expressed as a
 * join.
 */
function listVisibilityWhere(viewer: RepoViewer): Prisma.CommunityWhereInput {
  if (viewer.id === null) {
    return { deletedAt: null, visibility: "public" };
  }

  const notBlocked: Prisma.CommunityWhereInput = {
    owner: { blocksMade: { none: { blockedId: viewer.id } } },
  };

  if (viewer.role !== null && isAdminRole(viewer.role)) {
    return { deletedAt: null, ...notBlocked };
  }

  return {
    deletedAt: null,
    ...notBlocked,
    OR: [
      { visibility: "public" },
      { ownerId: viewer.id },
      { members: { some: { userId: viewer.id } } },
    ],
  };
}

/**
 * Sort keys map to indexed columns only (see `communities.schema.ts`).
 *
 * Both orderings are tie-broken by `id` so the cursor defines a **total**
 * order. Without that, two communities sharing a `createdAt` — which the seed
 * produces, since it inserts them in one pass — could straddle a page boundary
 * and be returned twice or skipped.
 */
function orderFor(sort: CommunitySort): Prisma.CommunityOrderByWithRelationInput[] {
  switch (sort) {
    case "members":
      return [{ memberCount: "desc" }, { createdAt: "desc" }, { id: "desc" }];
    case "recent":
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Slug lookup. Deliberately does **not** filter `deletedAt` — the visibility
 * gate needs to distinguish "soft-deleted" from "never existed" internally,
 * even though both resolve to the same 404 for the caller.
 */
export async function findBySlug(slug: string): Promise<CommunityDetailRow | null> {
  return prisma.community.findUnique({ where: { slug }, select: communityDetailSelect });
}

export async function findById(id: string): Promise<CommunityDetailRow | null> {
  return prisma.community.findUnique({ where: { id }, select: communityDetailSelect });
}

/**
 * The viewer's own membership row, or null.
 *
 * Fetched separately from the detail select, which carries only the moderating
 * members — a plain member reading their own community must still be told they
 * are a member.
 */
export async function findMembership(
  communityId: string,
  userId: string,
): Promise<{ role: CommunityRole } | null> {
  return prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    select: { role: true },
  });
}

export interface CommunityListFilter {
  category?: string | undefined;
  q?: string | undefined;
}

/**
 * Cursor-paginated discovery (decision J12).
 *
 * Over-fetches by one so `buildCursorPage` can report `nextCursor` without a
 * second COUNT — the Phase 6 pattern. `q` searches name and description
 * case-insensitively; it is not a full-text index, and Phase 10 owns search.
 */
export async function listCommunities(
  viewer: RepoViewer,
  filter: CommunityListFilter,
  sort: CommunitySort,
  cursor: string | undefined,
  take: number,
): Promise<CommunitySummaryRow[]> {
  /*
   * The visibility clause and the `q` clause both want `OR`, and a single
   * object literal cannot hold two — the second key would silently replace the
   * first, widening the visibility filter into "matches the search" and leaking
   * private communities. Both therefore go under `AND`, where they compose
   * instead of colliding.
   */
  const clauses: Prisma.CommunityWhereInput[] = [listVisibilityWhere(viewer)];

  if (filter.category !== undefined) {
    clauses.push({ category: filter.category });
  }

  if (filter.q !== undefined) {
    clauses.push({
      OR: [
        { name: { contains: filter.q, mode: "insensitive" } },
        { description: { contains: filter.q, mode: "insensitive" } },
      ],
    });
  }

  return prisma.community.findMany({
    where: { AND: clauses },
    select: communitySummarySelect,
    orderBy: orderFor(sort),
    take: take + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Communities a given user belongs to, subject to the viewer's own scope. */
export async function listByMember(
  userId: string,
  viewer: RepoViewer,
  cursor: string | undefined,
  take: number,
): Promise<CommunitySummaryRow[]> {
  return prisma.community.findMany({
    where: {
      ...listVisibilityWhere(viewer),
      members: { some: { userId } },
    },
    select: communitySummarySelect,
    orderBy: orderFor("recent"),
    take: take + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** One membership in the joined shape, for a write's response. */
export async function findMemberWithUser(
  communityId: string,
  userId: string,
): Promise<CommunityMemberRow | null> {
  return prisma.communityMember.findUnique({
    where: { communityId_userId: { communityId, userId } },
    select: memberSelect,
  });
}

/**
 * The moderating roster — owner, admins, and moderators.
 *
 * Unpaginated on purpose: it is a short bounded set, and it is what the shipped
 * sidebar renders. Ordered by rank rather than by `joinedAt` so the owner leads
 * the list; `role` is an enum, and Postgres orders enums by their declaration
 * sequence, which `CommunityRole` declares owner-first.
 */
export async function listModerators(communityId: string): Promise<CommunityMemberRow[]> {
  return prisma.communityMember.findMany({
    where: { communityId, role: { in: [...MODERATING_ROLES] } },
    select: memberSelect,
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
  });
}

/**
 * The member roster, cursor-paginated.
 *
 * The cursor is a **`userId`**, not the row's own id, and rides the
 * `@@unique([communityId, userId])` compound. `memberSelect` deliberately does
 * not expose `CommunityMember.id` — it is an internal surrogate the API has no
 * reason to hand out — so cursoring on it would mean either leaking it or
 * re-querying to translate. The compound unique is already the table's source
 * of truth, so it serves as the cursor too.
 *
 * `joinedAt` alone is not a total order (the seed inserts members in one pass),
 * so it is tie-broken by `userId` — the same column the cursor uses, which is
 * what keeps the page boundary stable.
 */
export async function listMembers(
  communityId: string,
  cursor: string | undefined,
  take: number,
): Promise<CommunityMemberRow[]> {
  return prisma.communityMember.findMany({
    where: { communityId },
    select: memberSelect,
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    take: take + 1,
    ...(cursor !== undefined
      ? { cursor: { communityId_userId: { communityId, userId: cursor } }, skip: 1 }
      : {}),
  });
}

/* ── Tags (decision J8) ──────────────────────────────────────────────────── */

export interface ResolvedTag {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolves tag references against the existing taxonomy.
 *
 * Unknown references are returned rather than created (decision J8):
 * communities attach to the taxonomy, they do not extend it — the same rule
 * Phase 5 applied to projects, and the reason both share one `Tag` table.
 */
export async function resolveTags(
  refs: string[],
): Promise<{ found: ResolvedTag[]; missing: string[] }> {
  if (refs.length === 0) return { found: [], missing: [] };

  const bySlug = new Map<string, string>();
  for (const ref of refs) bySlug.set(slugify(ref), ref);

  const rows = await prisma.tag.findMany({
    where: { slug: { in: [...bySlug.keys()] } },
    select: { id: true, name: true, slug: true },
  });

  const foundSlugs = new Set(rows.map((row) => row.slug));
  const missing = [...bySlug.entries()]
    .filter(([slug]) => !foundSlugs.has(slug))
    .map(([, original]) => original);

  return { found: rows, missing };
}

/**
 * Applies a replace-set of tags and moves `Tag.usageCount` for the delta.
 *
 * `Tag.usageCount` is a **single counter with two writers** — `ProjectTag` from
 * Phase 5 and `CommunityTag` from here (decision J8). It therefore counts total
 * usages across both, which is what the `usageCount desc` index is for, and it
 * is why this function must use the same guarded arithmetic Phase 5 uses rather
 * than recomputing a total from either table alone.
 *
 * The decrement is guarded by `usageCount: { gt: 0 }` in the same statement.
 * That is not defensive noise: the seed creates `CommunityTag` and `ProjectTag`
 * rows without ever touching `usageCount`, so seeded tags sit at 0 while
 * genuinely being in use. An unguarded decrement would drive them negative the
 * first time a seeded community's tags were edited.
 */
async function applyTagSet(
  tx: Prisma.TransactionClient,
  communityId: string,
  tagIds: string[],
): Promise<void> {
  const existing = await tx.communityTag.findMany({
    where: { communityId },
    select: { tagId: true },
  });

  const current = new Set(existing.map((row) => row.tagId));
  const next = new Set(tagIds);

  const toAdd = tagIds.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !next.has(id));

  if (toRemove.length > 0) {
    await tx.communityTag.deleteMany({ where: { communityId, tagId: { in: toRemove } } });
    await tx.tag.updateMany({
      where: { id: { in: toRemove }, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }

  if (toAdd.length > 0) {
    await tx.communityTag.createMany({
      data: toAdd.map((tagId) => ({ communityId, tagId })),
      skipDuplicates: true,
    });
    await tx.tag.updateMany({
      where: { id: { in: toAdd } },
      data: { usageCount: { increment: 1 } },
    });
  }
}

/**
 * Releases every tag a community holds, decrementing the shared counter.
 *
 * Used by deletion. Without it, soft-deleting a community would leave
 * `usageCount` permanently inflated — the exact drift the Phase 5 test-cleanup
 * bug produced, so it is fixed here by construction rather than discovered
 * later.
 */
async function releaseTags(
  tx: Prisma.TransactionClient,
  communityId: string,
): Promise<void> {
  const held = await tx.communityTag.findMany({
    where: { communityId },
    select: { tagId: true },
  });
  if (held.length === 0) return;

  const tagIds = held.map((row) => row.tagId);
  await tx.communityTag.deleteMany({ where: { communityId } });
  await tx.tag.updateMany({
    where: { id: { in: tagIds }, usageCount: { gt: 0 } },
    data: { usageCount: { decrement: 1 } },
  });
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

const MAX_SLUG_ATTEMPTS = 5;

function isSlugConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    // `target` names the constraint that failed; only a slug collision is
    // retryable, and any other unique violation must surface.
    String(error.meta?.["target"] ?? "").includes("slug")
  );
}

export interface CreateCommunityData {
  ownerId: string;
  name: string;
  description: string;
  category: string;
  visibility: Visibility;
  avatarUrl: string | null;
  bannerUrl: string | null;
  tagIds: string[];
}

/**
 * Creates a community, its owner membership, and its tag links in one
 * transaction.
 *
 * `memberCount` starts at 1, not 0: the owner counts as a member (decision J6)
 * and their `CommunityMember` row is created here, so the counter and the rows
 * agree from the first instant. Seeding it at 0 and incrementing afterwards
 * would leave a window where they disagreed.
 *
 * Slug collisions are resolved by **retrying the whole transaction** with the
 * next candidate rather than by looping inside it. A `P2002` aborts the
 * surrounding transaction in Postgres, so an in-transaction retry would run
 * every subsequent statement in a failed transaction block — the Phase 5
 * lesson, carried forward unchanged.
 */
export async function createCommunity(
  data: CreateCommunityData,
): Promise<CommunityDetailRow> {
  const base = initialSlugFor(data.name);
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = slugCandidate(base, attempt);

    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.community.create({
          data: {
            slug,
            ownerId: data.ownerId,
            name: data.name,
            description: data.description,
            category: data.category,
            visibility: data.visibility,
            avatarUrl: data.avatarUrl,
            bannerUrl: data.bannerUrl,
            memberCount: 1,
            members: { create: [{ userId: data.ownerId, role: "owner" }] },
          },
          select: { id: true },
        });

        if (data.tagIds.length > 0) {
          await applyTagSet(tx, created.id, data.tagIds);
        }

        return tx.community.findUniqueOrThrow({
          where: { id: created.id },
          select: communityDetailSelect,
        });
      });
    } catch (error) {
      if (!isSlugConflict(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

export interface UpdateCommunityData {
  name?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  visibility?: Visibility | undefined;
  avatarUrl?: string | null | undefined;
  bannerUrl?: string | null | undefined;
}

/**
 * Applies a patch. `slug` is absent from `UpdateCommunityData` by design —
 * renaming would break every existing link, and the frontend routes
 * `/communities/[communityId]` on the slug.
 */
export async function updateCommunity(
  communityId: string,
  data: UpdateCommunityData,
  tagIds: string[] | undefined,
): Promise<CommunityDetailRow> {
  return prisma.$transaction(async (tx) => {
    const patch: Prisma.CommunityUpdateInput = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.category !== undefined) patch.category = data.category;
    if (data.visibility !== undefined) patch.visibility = data.visibility;
    if (data.avatarUrl !== undefined) patch.avatarUrl = data.avatarUrl;
    if (data.bannerUrl !== undefined) patch.bannerUrl = data.bannerUrl;

    if (Object.keys(patch).length > 0) {
      await tx.community.update({ where: { id: communityId }, data: patch });
    }

    if (tagIds !== undefined) {
      await applyTagSet(tx, communityId, tagIds);
    }

    return tx.community.findUniqueOrThrow({
      where: { id: communityId },
      select: communityDetailSelect,
    });
  });
}

/**
 * Soft-deletes a community and releases its tags (decisions J13, J8).
 *
 * The membership rows are left in place. They are unreachable — every read
 * path goes through the gate, which refuses a deleted community — and removing
 * them would destroy the record of who was in it, which is the sort of thing a
 * later moderation or restore feature needs even though J13 forbids a restore
 * today.
 */
export async function softDeleteCommunity(communityId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await releaseTags(tx, communityId);
    await tx.community.update({
      where: { id: communityId },
      data: { deletedAt: new Date() },
    });
  });
}

/* ── Membership (decisions J6, J7) ───────────────────────────────────────── */

/**
 * Adds a membership and moves `memberCount` in the same transaction.
 *
 * The `@@unique([communityId, userId])` constraint is the arbiter, exactly as
 * the composite key was for Phase 6's likes: a duplicate raises `P2002`, the
 * transaction rolls back, and the increment rolls back with it. That is what
 * makes the counter correct under concurrency without a lock — and why the
 * increment is `{ increment: 1 }` rather than a read, add, and write.
 *
 * `P2002` is surfaced to the caller rather than swallowed, so the service can
 * answer 409 instead of silently reporting success for a join that did nothing.
 */
export async function addMember(
  communityId: string,
  userId: string,
  role: CommunityRole,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.communityMember.create({ data: { communityId, userId, role } });
    await tx.community.update({
      where: { id: communityId },
      data: { memberCount: { increment: 1 } },
    });
  });
}

/**
 * Removes a membership and moves `memberCount` in the same transaction.
 *
 * The decrement is gated on the delete having actually removed a row — the
 * `deleteMany` count — and on `memberCount: { gt: 0 }`. Two guards rather than
 * one because they fail differently: the first stops a no-op delete from
 * decrementing at all, the second stops a counter that has already drifted to 0
 * from going negative. Returns whether anything was removed so the service can
 * distinguish "left" from "was not a member".
 */
export async function removeMember(
  communityId: string,
  userId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.communityMember.deleteMany({
      where: { communityId, userId },
    });

    if (count === 0) return false;

    await tx.community.updateMany({
      where: { id: communityId, memberCount: { gt: 0 } },
      data: { memberCount: { decrement: 1 } },
    });

    return true;
  });
}

/**
 * Changes an existing member's role. No counter moves: the member count is
 * unchanged by a promotion.
 */
export async function setMemberRole(
  communityId: string,
  userId: string,
  role: CommunityRole,
): Promise<boolean> {
  const { count } = await prisma.communityMember.updateMany({
    where: { communityId, userId },
    data: { role },
  });

  return count > 0;
}

/**
 * Moves ownership, in one transaction (decision J7).
 *
 * Three writes that must not be separable: `Community.ownerId` moves, the new
 * owner's membership becomes `owner`, and the previous owner is demoted to
 * `admin` rather than removed — a founder who hands over should not lose access
 * to the community they built.
 *
 * The new owner's membership is `upsert`ed because the transfer target may not
 * already be a member; when they are not, `memberCount` moves with them. Both
 * halves of that pair are inside the transaction, so the invariant
 * "`ownerId` always has a `CommunityMember` row" holds at every commit point.
 */
export async function transferOwnership(
  communityId: string,
  fromUserId: string,
  toUserId: string,
): Promise<CommunityDetailRow> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.communityMember.findUnique({
      where: { communityId_userId: { communityId, userId: toUserId } },
      select: { userId: true },
    });

    if (existing === null) {
      await tx.communityMember.create({
        data: { communityId, userId: toUserId, role: "owner" },
      });
      await tx.community.update({
        where: { id: communityId },
        data: { memberCount: { increment: 1 } },
      });
    } else {
      await tx.communityMember.update({
        where: { communityId_userId: { communityId, userId: toUserId } },
        data: { role: "owner" },
      });
    }

    await tx.communityMember.updateMany({
      where: { communityId, userId: fromUserId },
      data: { role: "admin" },
    });

    await tx.community.update({
      where: { id: communityId },
      data: { ownerId: toUserId },
    });

    return tx.community.findUniqueOrThrow({
      where: { id: communityId },
      select: communityDetailSelect,
    });
  });
}

/* ── Rules (decision J11) ────────────────────────────────────────────────── */

/**
 * Replace-set: the submitted array *is* the rule list, and its index becomes
 * `position`. Delete-then-insert inside one transaction rather than a diff,
 * because a reorder changes every position anyway and the table is bounded at
 * 30 rows by the schema.
 */
export async function replaceRules(
  communityId: string,
  rules: string[],
): Promise<CommunityDetailRow> {
  return prisma.$transaction(async (tx) => {
    await tx.communityRule.deleteMany({ where: { communityId } });

    if (rules.length > 0) {
      await tx.communityRule.createMany({
        data: rules.map((content, position) => ({ communityId, content, position })),
      });
    }

    return tx.community.findUniqueOrThrow({
      where: { id: communityId },
      select: communityDetailSelect,
    });
  });
}

/* ── Events (decision J10) ───────────────────────────────────────────────── */

export interface CreateEventData {
  communityId: string;
  title: string;
  description: string;
  startsAt: Date;
  endsAt: Date | null;
  isOnline: boolean;
  location: string | null;
}

/**
 * Creates an event. `attendeeCount` is never written — it has no RSVP model
 * and therefore no writer (decision J10); it keeps its schema default.
 */
export async function createEvent(data: CreateEventData): Promise<CommunityEventRow> {
  return prisma.communityEvent.create({
    data: {
      communityId: data.communityId,
      title: data.title,
      description: data.description,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      isOnline: data.isOnline,
      location: data.location,
    },
    select: eventSelect,
  });
}

export interface UpdateEventData {
  title?: string | undefined;
  description?: string | undefined;
  startsAt?: Date | undefined;
  endsAt?: Date | null | undefined;
  isOnline?: boolean | undefined;
  location?: string | null | undefined;
}

export async function findEvent(
  communityId: string,
  eventId: string,
): Promise<CommunityEventRow | null> {
  return prisma.communityEvent.findFirst({
    where: { id: eventId, communityId },
    select: eventSelect,
  });
}

export async function updateEvent(
  eventId: string,
  data: UpdateEventData,
): Promise<CommunityEventRow> {
  const patch: Prisma.CommunityEventUpdateInput = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.description !== undefined) patch.description = data.description;
  if (data.startsAt !== undefined) patch.startsAt = data.startsAt;
  if (data.endsAt !== undefined) patch.endsAt = data.endsAt;
  if (data.isOnline !== undefined) patch.isOnline = data.isOnline;
  if (data.location !== undefined) patch.location = data.location;

  return prisma.communityEvent.update({
    where: { id: eventId },
    data: patch,
    select: eventSelect,
  });
}

export async function deleteEvent(eventId: string): Promise<void> {
  await prisma.communityEvent.delete({ where: { id: eventId } });
}

export async function listEvents(
  communityId: string,
  includePast: boolean,
  take: number,
): Promise<CommunityEventRow[]> {
  return prisma.communityEvent.findMany({
    where: {
      communityId,
      ...(includePast ? {} : { startsAt: { gte: new Date() } }),
    },
    select: eventSelect,
    orderBy: { startsAt: "asc" },
    take,
  });
}

/* ── Pinned posts (decision J14) ─────────────────────────────────────────── */

/**
 * Pins a post. The composite primary key `[communityId, postId]` is the
 * arbiter, so a duplicate pin raises `P2002` rather than creating a second row
 * — and because the key is composite, this table can never use the
 * `cursor: { id }` helper (decision J14). There is no id to cursor on.
 */
export async function pinPost(
  communityId: string,
  postId: string,
  pinnedById: string,
): Promise<void> {
  await prisma.communityPinnedPost.create({
    data: { communityId, postId, pinnedById },
  });
}

export async function unpinPost(communityId: string, postId: string): Promise<boolean> {
  const { count } = await prisma.communityPinnedPost.deleteMany({
    where: { communityId, postId },
  });
  return count > 0;
}

/** Whether a post is actually published into this community (decision J14). */
export async function postBelongsTo(
  communityId: string,
  postId: string,
  actorId: string,
): Promise<boolean> {
  const row = await prisma.post.findFirst({
    where: {
      id: postId,
      communityId,
      deletedAt: null,
      // The post must also be one the pinner can actually read. Without this a
      // moderator could pin another member's `private` post: the post itself
      // would still 404 on fetch, but its id would sit in `pinnedPostIds` for
      // everyone who can see the community — an id leak, and a pinned slot
      // pointing at something nobody can open.
      OR: [{ visibility: { not: "private" } }, { authorId: actorId }],
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Replaces the tag set on its own, without touching any other column.
 *
 * `updateCommunity` can already do this as part of a patch; this exists so the
 * dedicated `PUT /:slug/tags` route does not have to send an empty patch
 * alongside, and so the tag replacement is a single transaction of its own.
 */
export async function replaceTags(
  communityId: string,
  tagIds: string[],
): Promise<CommunityDetailRow> {
  return prisma.$transaction(async (tx) => {
    await applyTagSet(tx, communityId, tagIds);

    return tx.community.findUniqueOrThrow({
      where: { id: communityId },
      select: communityDetailSelect,
    });
  });
}

/** Which of these posts are pinned here — used to project pin state on a feed. */
export async function pinnedPostIds(communityId: string): Promise<string[]> {
  const rows = await prisma.communityPinnedPost.findMany({
    where: { communityId },
    select: { postId: true },
    orderBy: { pinnedAt: "desc" },
  });
  return rows.map((row) => row.postId);
}

export { communityDetailSelect, listVisibilityWhere };
