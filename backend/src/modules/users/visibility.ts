import type { ProfileVisibility, UserRole } from "@prisma/client";

/**
 * Profile visibility resolution (decision J4).
 *
 * A pure function on purpose: this is the rule that decides whether private
 * data leaves the server, and it should be testable without a database, an
 * HTTP request, or a session.
 */

/**
 * - `full`      — the viewer may see the complete profile.
 * - `redacted`  — identity-only shell (followers-only profile, non-follower).
 * - `not_found` — behave exactly as if the user did not exist.
 */
export type VisibilityDecision = "full" | "redacted" | "not_found";

export interface VisibilityContext {
  /** Null for anonymous callers. */
  viewerId: string | null;
  viewerRole: UserRole | null;
  targetId: string;
  targetVisibility: ProfileVisibility;
  /** Viewer follows the target. */
  isFollowing: boolean;
  /** The **target** has blocked the **viewer**. */
  targetBlockedViewer: boolean;
}

/** Mirrors `role.middleware.isAdminRole`; `guest` is never authorized. */
function isAdmin(role: UserRole | null): boolean {
  if (role === null || role === "guest") return false;
  return role === "moderator" || role === "community_admin" || role === "platform_admin";
}

/**
 * Order matters, and each branch is a deliberate privacy choice:
 *
 * 1. **Blocked wins over everything** and resolves to `not_found`, not `403`.
 *    A 403 would confirm the account exists and announce the block; 404 is
 *    indistinguishable from a deleted or never-existing account, which is the
 *    entire point of blocking. This is also why the block check precedes the
 *    self and admin checks — except that neither can co-occur with it.
 * 2. **Self** always sees their own profile, whatever the visibility setting.
 * 3. **Admins** see full profiles, matching the RBAC the frontend's
 *    `AdminGuard` already gates on. Moderation cannot work through a redacted
 *    view.
 * 4. **Public** is public.
 * 5. **Followers-only** opens to confirmed followers, and redacts otherwise —
 *    including for anonymous callers.
 */
export function resolveVisibility(context: VisibilityContext): VisibilityDecision {
  if (context.targetBlockedViewer) return "not_found";
  if (context.viewerId !== null && context.viewerId === context.targetId) return "full";
  if (isAdmin(context.viewerRole)) return "full";
  if (context.targetVisibility === "public") return "full";
  if (context.isFollowing) return "full";
  return "redacted";
}

/**
 * Whether `email` may appear in a profile response.
 *
 * Independent of `resolveVisibility` because a *public* profile still hides
 * the address unless its owner opted in. The two rules compose: a viewer can
 * be allowed the full profile and still not be shown the email.
 */
export function canSeeEmail(context: {
  viewerId: string | null;
  viewerRole: UserRole | null;
  targetId: string;
  showEmailOnProfile: boolean;
}): boolean {
  if (context.viewerId !== null && context.viewerId === context.targetId) return true;
  // Admins need it for moderation and the Phase 11 admin tables.
  if (isAdmin(context.viewerRole)) return true;
  return context.showEmailOnProfile;
}

export { isAdmin as isAdminRoleForVisibility };
