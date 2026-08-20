import type { Prisma } from "@prisma/client";

import { prisma } from "../../database/prisma.js";
import { summarySelect, type UserSummaryRow } from "../users/users.repository.js";

/**
 * The only layer that touches Prisma for `Follow` and `Block`
 * (BACKEND_ARCHITECTURE.md §4, decision J1).
 *
 * Two invariants are enforced here rather than in the service, because they
 * are only safe at the database level:
 *
 *   - **Counters move with the relationship.** `followersCount` /
 *     `followingCount` are denormalized (Phase 2), so every write pairs the
 *     row change with the counter change inside one transaction (decision J5).
 *   - **Blocking is atomic.** Removing both follow directions and inserting
 *     the block cannot be three separate statements, or a crash between them
 *     leaves a block with a surviving follow (decision J2).
 */

/* ── Relationship state ─────────────────────────────────────────────────── */

export async function isFollowing(
  followerId: string,
  followingId: string,
): Promise<boolean> {
  const row = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
    select: { id: true },
  });
  return row !== null;
}

export async function isBlocking(blockerId: string, blockedId: string): Promise<boolean> {
  const row = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    select: { id: true },
  });
  return row !== null;
}

export interface RelationshipRow {
  isFollowing: boolean;
  isFollowedBy: boolean;
  /** Viewer has blocked the other user. */
  isBlocking: boolean;
  /** The other user has blocked the viewer. */
  isBlockedBy: boolean;
}

/**
 * All four relationship facts in two queries rather than four round trips.
 *
 * `isBlockedBy` is returned for *server-side* decisions only — the view layer
 * drops it, because telling a user they have been blocked is a disclosure the
 * blocker did not consent to.
 */
export async function findRelationship(
  viewerId: string,
  otherId: string,
): Promise<RelationshipRow> {
  const [follows, blocks] = await Promise.all([
    prisma.follow.findMany({
      where: {
        OR: [
          { followerId: viewerId, followingId: otherId },
          { followerId: otherId, followingId: viewerId },
        ],
      },
      select: { followerId: true },
    }),
    prisma.block.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: otherId },
          { blockerId: otherId, blockedId: viewerId },
        ],
      },
      select: { blockerId: true },
    }),
  ]);

  return {
    isFollowing: follows.some((row) => row.followerId === viewerId),
    isFollowedBy: follows.some((row) => row.followerId === otherId),
    isBlocking: blocks.some((row) => row.blockerId === viewerId),
    isBlockedBy: blocks.some((row) => row.blockerId === otherId),
  };
}

/** True when either party has blocked the other. */
export async function blockExistsBetween(a: string, b: string): Promise<boolean> {
  const row = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: a, blockedId: b },
        { blockerId: b, blockedId: a },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/* ── Follow / unfollow ──────────────────────────────────────────────────── */

/**
 * Creates the follow and moves both counters in one transaction.
 *
 * Concurrency: the `@@unique([followerId, followingId])` index is what makes
 * this safe. Two simultaneous identical follows both attempt the insert;
 * exactly one commits and the other raises `P2002` and rolls back — including
 * its counter increments. `increment` compiles to `SET x = x + 1` under a row
 * lock, so two *different* followers of the same target serialize correctly
 * rather than clobbering each other with a read-modify-write.
 *
 * Throws Prisma `P2002` on duplicate; the service maps it to a conflict.
 */
export async function createFollow(
  followerId: string,
  followingId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.follow.create({ data: { followerId, followingId } });

    await tx.user.update({
      where: { id: followingId },
      data: { followersCount: { increment: 1 } },
    });
    await tx.user.update({
      where: { id: followerId },
      data: { followingCount: { increment: 1 } },
    });
  });
}

/**
 * Removes the follow if present, and reports whether it did.
 *
 * The counter decrements are gated on `deleteMany` having actually removed a
 * row, so a repeated unfollow cannot drive the counters negative — which is
 * what makes the endpoint safely idempotent.
 */
export async function deleteFollow(
  followerId: string,
  followingId: string,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const removed = await tx.follow.deleteMany({ where: { followerId, followingId } });
    if (removed.count === 0) return false;

    await tx.user.update({
      where: { id: followingId },
      data: { followersCount: { decrement: 1 } },
    });
    await tx.user.update({
      where: { id: followerId },
      data: { followingCount: { decrement: 1 } },
    });
    return true;
  });
}

/* ── Blocking ───────────────────────────────────────────────────────────── */

/**
 * Blocks `blockedId` on behalf of `blockerId` (decision J2).
 *
 * Deletes **both** follow directions before inserting the block, all in one
 * transaction. Removing only the blocker's own follow would leave the blocked
 * user still following — and therefore still receiving the blocker's posts
 * through the following feed, which is precisely what a block is meant to
 * stop.
 *
 * Returns how many follow rows were removed, so the service can audit it.
 */
export async function createBlock(
  blockerId: string,
  blockedId: string,
): Promise<{ followsRemoved: number }> {
  return prisma.$transaction(async (tx) => {
    let followsRemoved = 0;

    const forward = await tx.follow.deleteMany({
      where: { followerId: blockerId, followingId: blockedId },
    });
    if (forward.count > 0) {
      followsRemoved += forward.count;
      await tx.user.update({
        where: { id: blockedId },
        data: { followersCount: { decrement: forward.count } },
      });
      await tx.user.update({
        where: { id: blockerId },
        data: { followingCount: { decrement: forward.count } },
      });
    }

    const reverse = await tx.follow.deleteMany({
      where: { followerId: blockedId, followingId: blockerId },
    });
    if (reverse.count > 0) {
      followsRemoved += reverse.count;
      await tx.user.update({
        where: { id: blockerId },
        data: { followersCount: { decrement: reverse.count } },
      });
      await tx.user.update({
        where: { id: blockedId },
        data: { followingCount: { decrement: reverse.count } },
      });
    }

    await tx.block.create({ data: { blockerId, blockedId } });

    return { followsRemoved };
  });
}

/**
 * Removes the block. Deliberately does **not** restore the follows it
 * destroyed — re-following is the user's decision to make again, and silently
 * resurrecting a relationship the blocker deliberately severed would be a
 * surprising and unwanted side effect.
 */
export async function deleteBlock(
  blockerId: string,
  blockedId: string,
): Promise<boolean> {
  const removed = await prisma.block.deleteMany({ where: { blockerId, blockedId } });
  return removed.count > 0;
}

/* ── Listing ────────────────────────────────────────────────────────────── */

/** Cursor page over a follow edge, ordered newest-first by `createdAt`. */
interface FollowEdgePage {
  rows: { cursorId: string; user: UserSummaryRow }[];
}

function edgeArgs(cursor: string | undefined, limit: number) {
  return {
    // Over-fetch by one: the extra row proves more data exists without a
    // second COUNT (see `utils/pagination.buildCursorPage`).
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" } as const,
  } satisfies Partial<Prisma.FollowFindManyArgs>;
}

/** Users who follow `userId`. */
export async function listFollowers(
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<FollowEdgePage> {
  const rows = await prisma.follow.findMany({
    where: { followingId: userId, follower: { deletedAt: null } },
    select: { id: true, follower: { select: summarySelect } },
    ...edgeArgs(cursor, limit),
  });

  return { rows: rows.map((row) => ({ cursorId: row.id, user: row.follower })) };
}

/** Users `userId` follows. */
export async function listFollowing(
  userId: string,
  cursor: string | undefined,
  limit: number,
): Promise<FollowEdgePage> {
  const rows = await prisma.follow.findMany({
    where: { followerId: userId, following: { deletedAt: null } },
    select: { id: true, following: { select: summarySelect } },
    ...edgeArgs(cursor, limit),
  });

  return { rows: rows.map((row) => ({ cursorId: row.id, user: row.following })) };
}

/** Users the caller has blocked. */
export async function listBlocked(
  blockerId: string,
  cursor: string | undefined,
  limit: number,
): Promise<FollowEdgePage> {
  const rows = await prisma.block.findMany({
    where: { blockerId, blocked: { deletedAt: null } },
    select: { id: true, blocked: { select: summarySelect } },
    take: limit + 1,
    ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
  });

  return { rows: rows.map((row) => ({ cursorId: row.id, user: row.blocked })) };
}

/** Counter read used by tests and by the follow/unfollow response. */
export async function readCounters(
  userId: string,
): Promise<{ followersCount: number; followingCount: number } | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { followersCount: true, followingCount: true },
  });
}
