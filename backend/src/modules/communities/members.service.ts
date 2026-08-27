import type { CommunityRole } from "@prisma/client";

import { notificationPort } from "../../ports/notification.port.js";
import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import { buildCursorPage, type CursorPage } from "../../utils/pagination.js";
import * as usersRepo from "../users/users.repository.js";
import { canAssignRole, canManageMemberAt } from "./community.access.js";
import { resolveJoin } from "./community.visibility.js";
import { toCommunityMemberWithUser } from "./community.view.js";
import * as repo from "./communities.repository.js";
import {
  assertCan,
  isUniqueViolation,
  loadVisibleCommunity,
  viewerStateFor,
  type Actor,
  type CommunityContext,
  type Viewer,
} from "./communities.service.js";
import type {
  CommunityMemberWithUserView,
  CommunityViewerState,
} from "./communities.types.js";

/**
 * Community membership and role management (ARCHITECTURE §12, decisions
 * J4–J7).
 *
 * Split from `communities.service.ts` the way Phase 5 split `members.service`
 * from `projects.service`: the membership table has its own invariants — the
 * owner always holds a row, roles only move downward from the actor's rank,
 * and `memberCount` has to stay exact — and keeping them in one file makes
 * them reviewable together.
 *
 * Every function enters through `loadVisibleCommunity`, so a blocked viewer or
 * a private community is a 404 before any authorization question is asked.
 *
 * There are no invitations and no pending requests. `NotificationType` carries
 * `community_invite`, but no `CommunityInvite` model exists and the schema is
 * frozen, so a private community is joined by being *added* (decision J5).
 */

/* ── Listing ────────────────────────────────────────────────────────────── */

/**
 * The member roster.
 *
 * Cursor-paginated on `userId`, not on a synthetic row id: `CommunityMember`
 * does have an `id`, but the roster's natural order is `joinedAt` and the
 * cursor must be stable against it. `joinedAt` alone is not unique — the seed
 * inserts members in one pass — so the ordering is tie-broken in the
 * repository and the cursor rides the `userId`.
 */
export async function list(
  slug: string,
  viewer: Viewer,
  cursor: string | undefined,
  limit: number,
): Promise<CursorPage<CommunityMemberWithUserView>> {
  const context = await loadVisibleCommunity(slug, viewer);
  const rows = await repo.listMembers(context.row.id, cursor, limit);
  const page = buildCursorPage(rows, limit, (row) => row.userId);

  return {
    items: page.items.map(toCommunityMemberWithUser),
    nextCursor: page.nextCursor,
  };
}

/**
 * The moderating roster the shipped sidebar renders.
 *
 * A separate query rather than a filter over `list`, because a community's
 * moderators are a short bounded set and paging through thousands of ordinary
 * members to find them would be absurd.
 */
export async function listModerators(
  slug: string,
  viewer: Viewer,
): Promise<CommunityMemberWithUserView[]> {
  const context = await loadVisibleCommunity(slug, viewer);
  const rows = await repo.listModerators(context.row.id);

  return rows.map(toCommunityMemberWithUser);
}

/* ── Self-service (decision J5) ──────────────────────────────────────────── */

/**
 * Self-join.
 *
 * The visibility gate runs first, so a private community is already a 404 to a
 * non-member and never reaches `resolveJoin`. The `private` branch therefore
 * only fires for someone who *can* see it — a platform admin, for instance —
 * and it answers 403 rather than 404 because their ability to see it is not in
 * doubt; only their ability to join is.
 *
 * A duplicate join is a **409**, following the Phase 5 and Phase 6 convention
 * for a unique-constraint collision, rather than being silently idempotent. A
 * client that gets 201 for a join that created nothing cannot tell whether it
 * just joined or was already in.
 */
export async function join(slug: string, actor: Actor): Promise<CommunityViewerState> {
  const context = await loadVisibleCommunity(slug, actor);

  const decision = resolveJoin({
    visibility: context.row.visibility,
    isMember: context.memberRole !== null,
  });

  if (!decision.allowed) {
    if (decision.reason === "already_member") {
      throw AppError.conflict("You are already a member of this community");
    }
    throw AppError.authorization("This community is private — an admin has to add you");
  }

  try {
    await repo.addMember(context.row.id, actor.id, "member");
  } catch (error) {
    // The `@@unique([communityId, userId])` index is the real arbiter; this
    // turns the race between two simultaneous joins into a clean 409.
    if (isUniqueViolation(error)) {
      throw AppError.conflict("You are already a member of this community");
    }
    throw error;
  }

  const refreshed = await loadVisibleCommunity(slug, actor);
  return viewerStateFor(refreshed, actor);
}

/**
 * Self-leave.
 *
 * The owner may not leave. `Community.ownerId` is `onDelete: Restrict` and
 * would still name them, so removing their membership row would leave the
 * table contradicting the column — the drift decision J7 exists to prevent.
 * They transfer ownership or delete the community.
 */
export async function leave(slug: string, actor: Actor): Promise<{ left: boolean }> {
  const context = await loadVisibleCommunity(slug, actor);

  if (context.isOwner) {
    throw AppError.validation("The community owner cannot leave", [
      {
        field: "slug",
        message: "Transfer ownership first; the previous owner is demoted automatically.",
      },
    ]);
  }

  if (context.memberRole === null) {
    throw AppError.conflict("You are not a member of this community");
  }

  const left = await repo.removeMember(context.row.id, actor.id);
  return { left };
}

/* ── Managed membership (decision J4) ────────────────────────────────────── */

/** Resolves a handle, or 404s. Shared by every targeted operation below. */
async function resolveTarget(username: string): Promise<{ id: string }> {
  const target = await usersRepo.findByUsername(username);
  if (!target) {
    throw AppError.notFound("User not found");
  }
  return { id: target.id };
}

/**
 * Refuses any attempt to assign `owner` through the member routes.
 *
 * Ownership moves only through `transfer`, which rewrites `Community.ownerId`
 * and both membership rows in one transaction. Assigning the `owner` *role*
 * without moving the column is precisely how the two sources of truth drift
 * apart.
 */
function refuseOwnerRole(role: string | undefined): void {
  if (role === "owner") {
    throw AppError.validation("The owner role cannot be assigned directly", [
      { field: "role", message: "Use the ownership transfer endpoint instead." },
    ]);
  }
}

/**
 * Adds a member directly — the only route into a private community (J5).
 *
 * Two authorization questions, not one: the caller must hold `manage_members`,
 * and must be permitted to grant the specific role asked for. `canAssignRole`
 * keeps `admin` owner-only, which is what stops an admin minting a peer.
 */
export async function add(
  slug: string,
  actor: Actor,
  username: string,
  role: CommunityRole | undefined,
  auditContext: AuditContext,
): Promise<CommunityMemberWithUserView> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("manage_members", context, "You cannot manage this community's members");
  refuseOwnerRole(role);

  const target = role ?? "member";
  if (!canAssignRole(target, context.access)) {
    throw AppError.authorization("You may not assign that role");
  }

  const user = await resolveTarget(username);

  try {
    await repo.addMember(context.row.id, user.id, target);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict("That user is already a member of this community");
    }
    throw error;
  }

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.COMMUNITY_MEMBER_ADDED,
    targetType: "community",
    targetId: context.row.id,
    metadata: { memberId: user.id, role: target },
  });

  /*
   * Phase 9: the `community_invite` trigger.
   *
   * Being added to a community by someone else is the community analogue of
   * `project_invite`, which Phase 5 already announced from the equivalent
   * point in `projects/members.service.ts`. Joining under your own steam is
   * deliberately *not* announced — you already know you joined, and `resolveJoin`
   * is a different code path from this one.
   *
   * The port is fire-and-forget by contract, so a notification failure cannot
   * roll back a membership that is already committed and audited.
   */
  await notificationPort.emit({
    recipientId: user.id,
    actorId: actor.id,
    type: "community_invite",
    entityType: "community",
    entityId: context.row.id,
    subject: context.row.name,
  });

  return single(context, user.id);
}

/**
 * Changes a member's role.
 *
 * Both ends are checked. The caller must outrank the member's **current** role
 * (`canManageMemberAt`) *and* be permitted to grant the **new** one
 * (`canAssignRole`). Checking only the first would let an admin promote a
 * member straight to admin; checking only the second would let an admin demote
 * a peer.
 */
export async function updateRole(
  slug: string,
  actor: Actor,
  username: string,
  role: CommunityRole,
  auditContext: AuditContext,
): Promise<CommunityMemberWithUserView> {
  const context = await loadVisibleCommunity(slug, actor);
  refuseOwnerRole(role);

  const user = await resolveTarget(username);

  // Demoting the owner of record would leave `ownerId` naming someone the
  // membership table calls a moderator — the other half of the drift.
  if (user.id === context.row.ownerId) {
    throw AppError.validation("The community owner's role cannot be changed", [
      {
        field: "role",
        message: "Transfer ownership first; the previous owner is demoted automatically.",
      },
    ]);
  }

  const existing = await repo.findMembership(context.row.id, user.id);
  if (existing === null) {
    throw AppError.notFound("That user is not a member of this community");
  }

  if (!canManageMemberAt(existing.role, context.access)) {
    throw AppError.authorization("You may not change that member's role");
  }
  if (!canAssignRole(role, context.access)) {
    throw AppError.authorization("You may not assign that role");
  }

  await repo.setMemberRole(context.row.id, user.id, role);

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.COMMUNITY_ROLE_CHANGED,
    targetType: "community",
    targetId: context.row.id,
    metadata: { memberId: user.id, from: existing.role, to: role },
  });

  return single(context, user.id);
}

/**
 * Removes a member, or lets one remove themselves.
 *
 * Self-removal is routed through the same rules `leave` applies — including
 * the owner refusal — so the two endpoints cannot disagree about whether the
 * owner may walk out.
 *
 * A member who is not there is a **404**, following the Phase 5 convention: the
 * caller named a specific row to delete and it does not exist, which is not the
 * same as a successful no-op.
 */
export async function remove(
  slug: string,
  actor: Actor,
  username: string,
  auditContext: AuditContext,
): Promise<{ removed: boolean }> {
  const context = await loadVisibleCommunity(slug, actor);
  const user = await resolveTarget(username);

  // The owner cannot leave or be removed, by anyone, at any rank.
  if (user.id === context.row.ownerId) {
    throw AppError.validation("The community owner cannot be removed", [
      {
        field: "username",
        message: "Transfer ownership to another member first.",
      },
    ]);
  }

  const membership = await repo.findMembership(context.row.id, user.id);
  if (membership === null) {
    throw AppError.notFound("That user is not a member of this community");
  }

  const isSelf = user.id === actor.id;
  if (!isSelf && !canManageMemberAt(membership.role, context.access)) {
    throw AppError.authorization("You may not remove that member");
  }

  const removed = await repo.removeMember(context.row.id, user.id);

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.COMMUNITY_MEMBER_REMOVED,
    targetType: "community",
    targetId: context.row.id,
    metadata: { memberId: user.id, role: membership.role, self: isSelf },
  });

  return { removed };
}

/* ── Ownership (decision J7) ─────────────────────────────────────────────── */

/**
 * Transfers ownership.
 *
 * Owner-only: `transfer_ownership` sits in `OWNER_ONLY`, so neither a community
 * admin nor a platform admin can reassign someone's community. Reassigning
 * property is a moderation act, and moderation is a Phase 11 surface with its
 * own audited endpoints.
 *
 * The repository performs all four writes in one transaction — `ownerId`
 * moves, the successor's row becomes `owner`, the previous owner becomes
 * `admin`, and `memberCount` moves if the successor was not already a member —
 * so the invariant "`ownerId` always has a `CommunityMember` row" holds at
 * every commit point.
 */
export async function transfer(
  slug: string,
  actor: Actor,
  username: string,
  auditContext: AuditContext,
): Promise<CommunityMemberWithUserView[]> {
  const context = await loadVisibleCommunity(slug, actor);
  assertCan("transfer_ownership", context, "Only the owner may transfer this community");

  const user = await resolveTarget(username);

  if (user.id === context.row.ownerId) {
    throw AppError.conflict("That user already owns this community");
  }

  await repo.transferOwnership(context.row.id, context.row.ownerId, user.id);

  await recordAuditEvent({
    ...auditContext,
    actorId: actor.id,
    action: AuditAction.COMMUNITY_OWNERSHIP_TRANSFERRED,
    targetType: "community",
    targetId: context.row.id,
    metadata: { from: context.row.ownerId, to: user.id },
  });

  return repo
    .listModerators(context.row.id)
    .then((rows) => rows.map(toCommunityMemberWithUser));
}

/* ── Internals ──────────────────────────────────────────────────────────── */

/** Re-reads one membership for the response, so callers get the joined shape. */
async function single(
  context: CommunityContext,
  userId: string,
): Promise<CommunityMemberWithUserView> {
  const row = await repo.findMemberWithUser(context.row.id, userId);
  if (row === null) {
    // Only reachable if the row vanished between the write and this read.
    throw AppError.notFound("That user is not a member of this community");
  }
  return toCommunityMemberWithUser(row);
}
