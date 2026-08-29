import type { EntityType, ModerationStatus, UserRole } from "@prisma/client";

/**
 * Response shapes for the admin module (Phase 11).
 *
 * `admin.view.ts` is the only file that builds one. Every shape here is
 * narrower than the row behind it, and the narrowing is by construction.
 */

/** The person inside an `AdminUserSummary`; the frontend's `PostAuthor`. */
export interface AdminUserView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  builderRank: string;
}

/**
 * One row of the user-management table.
 *
 * Matches the frontend's `AdminUserSummary` exactly — `user`, `role`,
 * `status`, `joinedAt`, `projectsCount`, `followersCount`.
 *
 * **`email` is absent, deliberately.** It is the one field an administrator
 * might plausibly expect here and the one this projection will not serve. The
 * shipped table does not render it, `canSeeEmail` in `users/visibility.ts`
 * governs who may see an address and is not consulted by this module, and a
 * paginated table of every account's email is a credential-stuffing target
 * that no listed requirement asks for. An administrator who needs one address
 * can open that user's profile, where the existing rule applies.
 */
export interface AdminUserSummaryView {
  user: AdminUserView;
  role: UserRole;
  status: ModerationStatus;
  joinedAt: string;
  projectsCount: number;
  followersCount: number;
}

/** The four counters the shipped Overview and Analytics pages render. */
export interface AdminOverviewStatsView {
  totalUsers: number;
  totalProjects: number;
  totalCommunities: number;
  pendingReportsCount: number;
}

/** One bar of the weekly-signups chart. */
export interface WeeklySignupView {
  weekLabel: string;
  count: number;
}

/** One bar of the reports-by-reason chart. */
export interface ReportsByReasonView {
  reason: string;
  count: number;
}

/**
 * One audit row.
 *
 * `ipAddress` and `userAgent` are served because they are the point of an
 * audit trail and this endpoint is `platform_admin`-only. `metadata` passes
 * through as stored; `utils/audit.ts` already forbids credentials from
 * reaching it, which is where that rule belongs — a projection cannot
 * retroactively redact a secret that was written into the row.
 */
export interface AuditLogView {
  id: string;
  actorId: string | null;
  actor: AdminActorView | null;
  action: string;
  targetType: EntityType | null;
  targetId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** Three fields. An audit reader needs to know who, not what rank they hold. */
export interface AdminActorView {
  id: string;
  username: string;
  displayName: string;
}
