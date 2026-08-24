import type { CommunityRole, UserRole } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";

/**
 * Resource-level authorization for communities
 * (ARCHITECTURE §12, PRD §12, decision J4).
 *
 * ARCHITECTURE §12 states the requirement in one line — *"Permissions must be
 * verified server-side"* — and lists four roles without saying what any of them
 * may do. This table is that specification, kept as a **pure function over a
 * static table** so every (action × role) pair is enumerable in a unit test
 * rather than discovered in production.
 *
 * The shape follows `project.access.ts`, but the grants are not a copy of it.
 * A project's roles describe *what someone builds* (developer, designer,
 * contributor); a community's describe *how much of the place someone runs*.
 * The two happen to share the words `owner` and `admin` and share nothing else,
 * so the tables are deliberately separate.
 */

export type CommunityAction =
  | "edit_community"
  | "delete_community"
  | "transfer_ownership"
  | "manage_members"
  | "assign_admin_role"
  | "manage_rules"
  | "manage_events"
  | "pin_posts"
  | "remove_posts"
  | "create_post";

/**
 * What each **membership** role may do. Ownership is checked separately and
 * always wins, so `owner` here describes someone holding the `owner`
 * *membership* row — normally the same person as `Community.ownerId`, but the
 * two are distinct records and this table must not assume they agree.
 *
 * Two grants deserve their reasoning stated.
 *
 * **`member` may only `create_post`.** Decision J4 is explicit that
 * non-members cannot post even to a public community, which makes posting the
 * one thing membership actually buys. Everything above it is running the
 * place.
 *
 * **`moderator` gets `manage_events` but not `manage_rules`.** Events are
 * operational — someone has to be able to schedule and correct them. Rules are
 * the community's constitution; rewriting them is an `admin` act. That split
 * mirrors how the shipped page presents the two: events are a dated feed,
 * rules are a numbered charter.
 */
const ROLE_PERMISSIONS: Record<CommunityRole, readonly CommunityAction[]> = {
  /**
   * Note what is *missing*: `transfer_ownership` and `assign_admin_role`.
   *
   * This table describes what a **membership role** grants, and those two are
   * reserved to the owner *of record* — `Community.ownerId` — which is a
   * different record from the `owner` membership row (decision J7). Listing
   * them here would make the table disagree with `can()`, which short-circuits
   * on `OWNER_ONLY` before ever consulting this map. A membership row that has
   * drifted from `ownerId` must not confer the authority to rewrite `ownerId`.
   */
  owner: [
    "edit_community",
    "delete_community",
    "manage_members",
    "manage_rules",
    "manage_events",
    "pin_posts",
    "remove_posts",
    "create_post",
  ],
  admin: [
    "edit_community",
    "manage_members",
    "manage_rules",
    "manage_events",
    "pin_posts",
    "remove_posts",
    "create_post",
  ],
  moderator: ["manage_events", "pin_posts", "remove_posts", "create_post"],
  member: ["create_post"],
};

/**
 * Actions reserved to the community's *owner of record* — not a member holding
 * the `admin` role, and not a platform admin.
 *
 * `transfer_ownership` rewrites `Community.ownerId`, the authoritative
 * ownership source (decision J7); letting a platform admin reassign someone's
 * community would be a moderation action, and moderation actions are a Phase 11
 * surface with their own audit requirements.
 *
 * `assign_admin_role` is here for a subtler reason: without it, an `admin`
 * holding `manage_members` could promote a second admin, or promote
 * themselves toward the owner's authority. Role escalation has to terminate
 * somewhere, and the owner is where it terminates.
 *
 * Note `delete_community` is deliberately **not** owner-only. Removing content
 * is the one moderation power the shipped `AdminGuard` already implies, and
 * Phase 5 drew the same line for projects.
 */
const OWNER_ONLY: readonly CommunityAction[] = [
  "transfer_ownership",
  "assign_admin_role",
];

/**
 * Actions a platform admin may **not** reach by role alone.
 *
 * `create_post` is the surprising one, and it is the point of decision J4:
 * posting is participation, not moderation. A platform admin who wants to post
 * in a community joins it like everyone else. Letting the admin bypass grant it
 * would mean the "non-members cannot post" rule quietly had an exception that
 * no part of the UI communicates.
 */
const NOT_VIA_PLATFORM_ADMIN: readonly CommunityAction[] = ["create_post"];

export interface CommunityAccessContext {
  /** Viewer is `Community.ownerId` — the authoritative ownership source. */
  isOwner: boolean;
  /** Viewer's `CommunityMember.role`, or null when they hold no membership. */
  memberRole: CommunityRole | null;
  /** Platform-level role, for the admin bypass. Null for anonymous callers. */
  viewerRole: UserRole | null;
}

/**
 * The single authorization predicate for every community write.
 *
 * Evaluated in order: owner of record → owner-only gate → platform admin →
 * membership table. Anonymous callers reach none of them, and `guest` never
 * satisfies `isAdminRole` (it is the frontend's "not signed in" sentinel and is
 * never persisted).
 */
export function can(action: CommunityAction, context: CommunityAccessContext): boolean {
  if (context.isOwner) return true;

  // Owner-only actions stop here: no membership role and no platform role
  // substitutes for being the owner of record.
  if (OWNER_ONLY.includes(action)) return false;

  if (
    context.viewerRole !== null &&
    isAdminRole(context.viewerRole) &&
    !NOT_VIA_PLATFORM_ADMIN.includes(action)
  ) {
    return true;
  }

  if (context.memberRole === null) return false;
  return ROLE_PERMISSIONS[context.memberRole].includes(action);
}

/**
 * Rank of each role, for comparisons the flat permission table cannot express.
 *
 * `manage_members` is a single grant, but "may manage members" is not a single
 * question: an `admin` may remove a `moderator` and must not be able to remove
 * the `owner`. Ordering the roles lets that be asked directly.
 */
const ROLE_RANK: Record<CommunityRole, number> = {
  owner: 3,
  admin: 2,
  moderator: 1,
  member: 0,
};

/**
 * Whether `context` may change or remove a member currently holding
 * `targetRole` (decision J4 — "manage lower roles/members").
 *
 * A manager may only act on someone **strictly below** their own rank. This is
 * what stops two admins from removing each other, and what stops an admin from
 * touching the owner.
 *
 * The owner of record is exempt from the rank comparison, because their
 * membership row is not the source of their authority — `Community.ownerId`
 * is. A platform admin is likewise allowed through, since `manage_members` is
 * not in `NOT_VIA_PLATFORM_ADMIN`; they are still refused the owner by the
 * explicit guard below, which no rank comparison would have caught for a
 * caller who holds no membership at all.
 */
export function canManageMemberAt(
  targetRole: CommunityRole,
  context: CommunityAccessContext,
): boolean {
  if (!can("manage_members", context)) return false;

  // Nobody demotes or removes the owner through the member routes; ownership
  // moves only through `transfer_ownership` (decision J7).
  if (targetRole === "owner") return false;

  if (context.isOwner) return true;

  if (context.memberRole === null) {
    // A platform admin acting without membership. Permitted for every
    // non-owner role — the owner case was already refused above.
    return context.viewerRole !== null && isAdminRole(context.viewerRole);
  }

  return ROLE_RANK[context.memberRole] > ROLE_RANK[targetRole];
}

/**
 * Whether this caller may *grant* `targetRole`.
 *
 * Assigning `admin` is owner-only (see `OWNER_ONLY`), and `owner` is never
 * assignable through the member routes at all — a community acquires a new
 * owner through the audited transfer, which moves `Community.ownerId` and the
 * membership row together in one transaction (decision J7).
 */
export function canAssignRole(
  targetRole: CommunityRole,
  context: CommunityAccessContext,
): boolean {
  if (targetRole === "owner") return false;
  if (targetRole === "admin") return can("assign_admin_role", context);
  return can("manage_members", context);
}

/**
 * Whether a post inside this community may be edited or removed by this caller.
 *
 * Authorship is checked first and separately: an author may always remove their
 * own post even though they hold no `remove_posts` grant, which is why this
 * cannot be expressed as a plain row in the table above. It mirrors
 * `canModifyUpdate` in the projects module.
 */
export function canRemovePost(
  context: CommunityAccessContext & { isAuthor: boolean },
): boolean {
  if (context.isAuthor) return true;
  return can("remove_posts", context);
}

/**
 * Roles a client may *assign* through the API.
 *
 * `owner` is absent by construction (see `canAssignRole`). The remaining three
 * are the roles a community actually hands out.
 */
export const ASSIGNABLE_COMMUNITY_ROLES = [
  "admin",
  "moderator",
  "member",
] as const satisfies readonly CommunityRole[];

export type AssignableCommunityRole = (typeof ASSIGNABLE_COMMUNITY_ROLES)[number];

/**
 * Roles that appear in `CommunityView.moderatorIds`.
 *
 * The shipped sidebar labels the list "Moderators" and means "people who run
 * this place", so the owner and admins belong in it — see the field's own note
 * in `communities.types.ts`.
 */
export const MODERATING_ROLES = [
  "owner",
  "admin",
  "moderator",
] as const satisfies readonly CommunityRole[];

export { ROLE_PERMISSIONS, ROLE_RANK };
