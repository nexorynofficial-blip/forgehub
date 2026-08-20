import { Prisma } from "@prisma/client";

import { notificationPort } from "../../ports/notification.port.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildCursorPage } from "../../utils/pagination.js";
import { toUserPreview } from "../users/user.view.js";
import * as usersRepo from "../users/users.repository.js";
import { resolveVisibility } from "../users/visibility.js";
import type { Viewer } from "../users/users.service.js";
import * as repo from "./follows.repository.js";
import type {
  BlockMutationResult,
  FollowListPage,
  FollowMutationResult,
} from "./follows.types.js";

/**
 * Social graph business logic (decisions J2, J3, J5).
 *
 * The service owns the *rules*; the repository owns the *atomicity*. That
 * split matters here: "a block removes both follows" is a rule, but making it
 * un-interruptible is a transaction, and putting the transaction in the
 * service would mean reaching past the repository into Prisma.
 */

/** Resolves a username to an id, or 404s. Callers never pass ids. */
async function resolveTarget(
  username: string,
): Promise<{ id: string; username: string }> {
  const target = await usersRepo.findByUsername(username);

  if (!target) {
    throw AppError.notFound("User not found");
  }

  return { id: target.id, username: target.username };
}

async function relationshipView(actorId: string, targetId: string) {
  const state = await repo.findRelationship(actorId, targetId);
  return {
    isSelf: false,
    isFollowing: state.isFollowing,
    isFollowedBy: state.isFollowedBy,
    // `isBlockedBy` is never surfaced — see users.types.RelationshipView.
    isBlocking: state.isBlocking,
  };
}

/* ── Follow ─────────────────────────────────────────────────────────────── */

/**
 * Follows a user.
 *
 * Not idempotent: a repeat follow is a `409`. POST creates a relationship,
 * and silently succeeding would hide a client bug — an over-eager double-tap
 * that double-counted would be far worse, and the unique index is what makes
 * the second attempt detectable at all.
 */
export async function follow(
  actorId: string,
  username: string,
): Promise<FollowMutationResult> {
  const target = await resolveTarget(username);

  if (target.id === actorId) {
    throw AppError.validation("You cannot follow yourself");
  }

  // Either direction of a block forbids the edge. Checking only "did they
  // block me" would let a blocker keep following the person they blocked,
  // which is incoherent — and checking only the reverse would let a blocked
  // user re-establish the connection the block was meant to sever.
  if (await repo.blockExistsBetween(actorId, target.id)) {
    // Same message and status as a missing user: confirming that a *block*
    // specifically is in the way would disclose it.
    throw AppError.notFound("User not found");
  }

  try {
    await repo.createFollow(actorId, target.id);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw AppError.conflict("You already follow this user");
    }
    throw error;
  }

  // Phase 9 turns this into a real notification. The port keeps the follows
  // service from knowing that notifications are a database table.
  await notificationPort.emit({
    recipientId: target.id,
    actorId,
    type: "follower",
  });

  const counters = await repo.readCounters(target.id);

  return {
    following: true,
    followersCount: counters?.followersCount ?? 0,
    relationship: await relationshipView(actorId, target.id),
  };
}

/**
 * Unfollows a user. **Idempotent** — unfollowing someone you do not follow
 * succeeds. DELETE means "ensure this relationship is absent", and the
 * counters only move when a row was actually removed, so repeating the call
 * cannot drive them negative.
 */
export async function unfollow(
  actorId: string,
  username: string,
): Promise<FollowMutationResult> {
  const target = await resolveTarget(username);

  if (target.id === actorId) {
    throw AppError.validation("You cannot unfollow yourself");
  }

  await repo.deleteFollow(actorId, target.id);
  const counters = await repo.readCounters(target.id);

  return {
    following: false,
    followersCount: counters?.followersCount ?? 0,
    relationship: await relationshipView(actorId, target.id),
  };
}

/* ── Blocking ───────────────────────────────────────────────────────────── */

/**
 * Blocks a user (decision J2).
 *
 * The follow teardown happens inside the repository's transaction so a
 * failure cannot leave a block coexisting with a live follow. Blocking
 * someone already blocked is a conflict rather than a silent success, so a
 * client can tell the difference between "done" and "already done".
 */
export async function block(
  actorId: string,
  username: string,
  context: AuditContext,
): Promise<BlockMutationResult> {
  const target = await resolveTarget(username);

  if (target.id === actorId) {
    throw AppError.validation("You cannot block yourself");
  }

  if (await repo.isBlocking(actorId, target.id)) {
    throw AppError.conflict("You have already blocked this user");
  }

  const { followsRemoved } = await repo.createBlock(actorId, target.id);

  await recordAuditEvent({
    ...context,
    actorId,
    action: AuditAction.USER_BLOCKED,
    targetType: "user",
    targetId: target.id,
    metadata: { followsRemoved },
  });

  return { blocking: true, followsRemoved };
}

/**
 * Unblocks a user. Deliberately does **not** restore the follows the block
 * destroyed — see `follows.repository.deleteBlock`.
 */
export async function unblock(
  actorId: string,
  username: string,
  context: AuditContext,
): Promise<BlockMutationResult> {
  const target = await resolveTarget(username);
  const removed = await repo.deleteBlock(actorId, target.id);

  if (removed) {
    await recordAuditEvent({
      ...context,
      actorId,
      action: AuditAction.USER_UNBLOCKED,
      targetType: "user",
      targetId: target.id,
    });
  }

  return { blocking: false, followsRemoved: 0 };
}

/* ── Lists ──────────────────────────────────────────────────────────────── */

type EdgeLister = (
  userId: string,
  cursor: string | undefined,
  limit: number,
) => Promise<{ rows: { cursorId: string; user: usersRepo.UserSummaryRow }[] }>;

/**
 * Shared paging for followers / following.
 *
 * The cursor is the **join row's** id, not the user's — following the same
 * person twice is impossible, but paging by user id would break the moment
 * an edge is deleted mid-scroll.
 */
async function listEdges(
  lister: EdgeLister,
  userId: string,
  query: { cursor?: string | undefined; limit: number },
): Promise<FollowListPage> {
  const { rows } = await lister(userId, query.cursor, query.limit);
  const page = buildCursorPage(rows, query.limit, (row) => row.cursorId);

  return {
    items: page.items.map((row) => toUserPreview(row.user)),
    nextCursor: page.nextCursor,
  };
}

/**
 * Resolves a target for a *list* read, applying the same visibility rule the
 * profile itself uses.
 *
 * This is not belt-and-braces. Without it, a followers-only profile would
 * still hand its follower and following lists to anyone who asked — turning
 * the list endpoints into a way around the privacy setting the user chose,
 * and leaking their social graph wholesale.
 */
async function resolveVisibleTarget(
  username: string,
  viewer: Viewer,
): Promise<{ id: string }> {
  const target = await usersRepo.findByUsername(username);

  if (!target) {
    throw AppError.notFound("User not found");
  }

  const relationship =
    viewer.id !== null && viewer.id !== target.id
      ? await repo.findRelationship(viewer.id, target.id)
      : null;

  const decision = resolveVisibility({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    targetId: target.id,
    targetVisibility: target.profile?.visibility ?? "public",
    isFollowing: relationship?.isFollowing ?? false,
    targetBlockedViewer: relationship?.isBlockedBy ?? false,
  });

  // Both a block and a redacted profile answer 404 here rather than 403 —
  // matching the profile endpoint exactly, so comparing the two responses
  // reveals nothing about which rule applied.
  if (decision !== "full") {
    throw AppError.notFound("User not found");
  }

  return { id: target.id };
}

/** Followers of `username`, subject to that user's profile visibility. */
export async function listFollowers(
  username: string,
  viewer: Viewer,
  query: { cursor?: string | undefined; limit: number },
): Promise<FollowListPage> {
  const target = await resolveVisibleTarget(username, viewer);
  return listEdges(repo.listFollowers, target.id, query);
}

/** Users `username` follows, subject to that user's profile visibility. */
export async function listFollowing(
  username: string,
  viewer: Viewer,
  query: { cursor?: string | undefined; limit: number },
): Promise<FollowListPage> {
  const target = await resolveVisibleTarget(username, viewer);
  return listEdges(repo.listFollowing, target.id, query);
}

/** The caller's own block list. Never readable for another user. */
export async function listBlocked(
  actorId: string,
  query: { cursor?: string | undefined; limit: number },
): Promise<FollowListPage> {
  return listEdges(repo.listBlocked, actorId, query);
}

/** Relationship state between the caller and another user. */
export async function getRelationship(actorId: string, username: string) {
  const target = await resolveTarget(username);

  if (target.id === actorId) {
    return { isSelf: true, isFollowing: false, isFollowedBy: false, isBlocking: false };
  }

  return relationshipView(actorId, target.id);
}
