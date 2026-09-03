import type { ID, ISODateString, UserRole } from "./common";
import type { PostAuthor } from "./feed";

/** Presentation-layer types for the Admin Dashboard (Phase 11). PRD.md §4.12
 * lists Reports/Moderation Queue/Flagged Posts/Content Removal/Ban Users/
 * Shadow Ban as one connected workflow — modeled here as one `Report`
 * entity with actions, not six separate features. See docs/ASSUMPTIONS.md. */

export type ReportTargetType = "post" | "comment" | "project" | "community" | "user";

export type ReportReason =
  "spam" | "harassment" | "inappropriate_content" | "impersonation" | "other";

export type ReportStatus = "pending" | "resolved" | "dismissed";

export interface Report {
  id: ID;
  reporterId: ID;
  targetType: ReportTargetType;
  targetId: ID;
  targetAuthorId: ID | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: ISODateString;
}

/**
 * A report with its participants resolved.
 *
 * `reporter` is nullable — a report outlives its reporter's account — and
 * there is deliberately **no `targetSummary`**: the API serves no snippet of
 * the reported content, because building one would mean projecting the text of
 * a private project or a direct message into a moderation response. The queue
 * identifies what was reported; staff open the target to read it.
 *
 * `ModerationReport` (`lib/services/admin-service.ts`) extends this with the
 * review fields the API also carries.
 */
export interface ReportWithDetails extends Report {
  reporter: PostAuthor | null;
  targetAuthor: PostAuthor | null;
}

/** PRD.md §4.12 "Ban Users" / "Shadow Ban" — a user's moderation state,
 * distinct from their `UserRole` (permissions) and both distinct from
 * PRD.md §4.9's project-level roles. */
export type ModerationStatus = "active" | "banned" | "shadow_banned";

export interface AdminUserSummary {
  user: PostAuthor;
  role: UserRole;
  status: ModerationStatus;
  joinedAt: ISODateString;
  projectsCount: number;
  followersCount: number;
}

export interface AdminOverviewStats {
  totalUsers: number;
  totalProjects: number;
  totalCommunities: number;
  pendingReportsCount: number;
}
