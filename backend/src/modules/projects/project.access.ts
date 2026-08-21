import type { ProjectMemberRole, UserRole } from "@prisma/client";

import { isAdminRole } from "../../middleware/role.middleware.js";

/**
 * Resource-level authorization for projects
 * (BACKEND_ARCHITECTURE.md §18, decision J8).
 *
 * §18 uses `DELETE /projects/123` as its worked example — *"Is Project 123
 * owned by User A? OR does User A have sufficient project permissions?"* — so
 * this is where that two-tier check finally gets built.
 *
 * `assertOwnershipOrAdmin` from `role.middleware.ts` answers only the first
 * half. It has no notion of a collaborator, and a project where only the owner
 * could ever write would make `ProjectMember.role` decorative. The table below
 * is the second half, kept as a **pure function over a static table** so every
 * (action × role) pair is enumerable in a unit test rather than discovered in
 * production.
 */

export type ProjectAction =
  | "edit_project"
  | "delete_project"
  | "transfer_ownership"
  | "manage_members"
  | "assign_owner_role"
  | "manage_milestones"
  | "create_update"
  | "moderate_updates";

/**
 * What each **membership** role may do. Ownership is checked separately and
 * always wins, so `owner` here describes someone holding the `owner`
 * *membership* row — normally the same person, but the two are distinct
 * records and this table must not assume they agree.
 *
 * `contributor` is deliberately the narrowest writing role: it can post an
 * update and nothing else. That mirrors what the word means on the shipped
 * project page, where contributors are credited rather than in charge.
 */
const ROLE_PERMISSIONS: Record<ProjectMemberRole, readonly ProjectAction[]> = {
  owner: [
    "edit_project",
    "delete_project",
    "transfer_ownership",
    "manage_members",
    "assign_owner_role",
    "manage_milestones",
    "create_update",
    "moderate_updates",
  ],
  admin: [
    "edit_project",
    "manage_members",
    "manage_milestones",
    "create_update",
    "moderate_updates",
  ],
  developer: ["manage_milestones", "create_update"],
  designer: ["manage_milestones", "create_update"],
  collaborator: ["manage_milestones", "create_update"],
  contributor: ["create_update"],
};

/**
 * Actions that belong to the project's *owner of record* and to nobody else —
 * not a member holding the `admin` role, and not a platform admin.
 *
 * Ownership transfer is here because it rewrites `Project.ownerId`, which is
 * the authoritative ownership source (decision J8); letting a platform admin
 * reassign someone's project would be a moderation action, and moderation
 * actions are a Phase 11 surface with their own audit requirements. Deletion is
 * here for the same reason — but platform admins *do* get it, since removing
 * content is the one moderation power the shipped `AdminGuard` already implies.
 */
const OWNER_ONLY: readonly ProjectAction[] = ["transfer_ownership", "assign_owner_role"];

export interface ProjectAccessContext {
  /** Viewer is `Project.ownerId` — the authoritative ownership source. */
  isOwner: boolean;
  /** Viewer's `ProjectMember.role`, or null when they hold no membership. */
  memberRole: ProjectMemberRole | null;
  /** Platform-level role, for the admin bypass. Null for anonymous callers. */
  viewerRole: UserRole | null;
}

/**
 * The single authorization predicate for every project write.
 *
 * Evaluated in order: owner of record → platform admin → membership table.
 * Anonymous callers reach none of them, and `guest` never satisfies
 * `isAdminRole` (it is the frontend's "not signed in" sentinel and is never
 * persisted).
 */
export function can(action: ProjectAction, context: ProjectAccessContext): boolean {
  if (context.isOwner) return true;

  // Owner-only actions stop here: no membership role and no platform role
  // substitutes for being the owner of record.
  if (OWNER_ONLY.includes(action)) return false;

  if (context.viewerRole !== null && isAdminRole(context.viewerRole)) return true;

  if (context.memberRole === null) return false;
  return ROLE_PERMISSIONS[context.memberRole].includes(action);
}

/**
 * Whether an update may be edited or removed by this caller.
 *
 * Authorship is checked first and separately: a contributor may always edit
 * their *own* update even though they hold no `moderate_updates` grant, which
 * is why this cannot be expressed as a plain row in the table above.
 */
export function canModifyUpdate(
  context: ProjectAccessContext & { isAuthor: boolean },
): boolean {
  if (context.isAuthor) return true;
  return can("moderate_updates", context);
}

/** Every role a client may *assign* through the API (decision J4). */
export const ASSIGNABLE_MEMBER_ROLES = [
  "owner",
  "collaborator",
  "contributor",
] as const satisfies readonly ProjectMemberRole[];

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

export { ROLE_PERMISSIONS };
