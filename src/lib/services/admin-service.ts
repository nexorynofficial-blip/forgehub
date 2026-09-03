import type {
  AdminOverviewStats,
  AdminUserSummary,
  ModerationStatus,
  Report,
  ReportReason,
  ReportStatus,
  ReportWithDetails,
  UserRole,
} from "@/types";
import { api, type OffsetPage } from "@/lib/api";

/**
 * Moderation and administration (`backend/src/modules/admin` and
 * `.../moderation`).
 *
 * Both are **offset**-paginated, so both go through `api.getPaginated` — the
 * envelope's `pagination` sits beside `data` and a plain `api.get` would drop
 * it. This reuses the adapter Checkpoint 3 added for projects rather than
 * introducing a second one.
 *
 * Authorization is entirely the backend's. Nothing here checks a role before
 * calling: `requireAdmin` / `requirePlatformAdmin` guard every route, and a
 * frontend that pre-filtered would be duplicating a decision it cannot
 * enforce. The admin UI hides what a non-admin should not *see*; the server
 * decides what anyone may *do*.
 */

/* ── Stats & analytics ────────────────────────────────────────────────────── */

/** `GET /admin/stats` — the four counters the Overview page renders. */
export async function getOverviewStats(): Promise<AdminOverviewStats> {
  return api.get<AdminOverviewStats>("/admin/stats");
}

/** `GET /admin/analytics/signups`. */
export async function getWeeklySignups(): Promise<
  { weekLabel: string; count: number }[]
> {
  const { signups } = await api.get<{ signups: { weekLabel: string; count: number }[] }>(
    "/admin/analytics/signups",
  );
  return signups;
}

/**
 * `GET /admin/analytics/reports-by-reason`.
 *
 * The backend returns `reason` as a plain string. It is narrowed to
 * `ReportReason` here because the values come from the same enum the report
 * schema validates against, and the chart keys its labels off that union.
 */
export async function getReportsByReason(): Promise<
  { reason: ReportReason; count: number }[]
> {
  const { reasons } = await api.get<{ reasons: { reason: string; count: number }[] }>(
    "/admin/analytics/reports-by-reason",
  );
  return reasons.map((row) => ({ reason: row.reason as ReportReason, count: row.count }));
}

/* ── User management ──────────────────────────────────────────────────────── */

export interface AdminUserListParams {
  page?: number;
  limit?: number;
  role?: UserRole;
  status?: ModerationStatus;
}

/**
 * `GET /admin/users`.
 *
 * The projection carries no email address — deliberately, on the backend's
 * side: a paginated table of every account's email is a credential-stuffing
 * target, and the shipped table never rendered one.
 */
export async function getAdminUsers(
  params: AdminUserListParams = {},
): Promise<OffsetPage<AdminUserSummary>> {
  return api.getPaginated<AdminUserSummary>("/admin/users", { query: { ...params } });
}

/**
 * The Overview page's "recently joined" widget.
 *
 * No client-side sort: the endpoint already orders by `createdAt` descending,
 * so the newest accounts are simply the first rows of page one. Re-sorting a
 * single page would have looked like a global ordering while only ever
 * reordering the twenty rows in hand.
 */
export async function getRecentlyJoinedUsers(limit = 4): Promise<AdminUserSummary[]> {
  const page = await getAdminUsers({ page: 1, limit });
  return page.items;
}

/** `PATCH /admin/users/{id}/role` — platform-admin only, server-enforced. */
export async function updateUserRole(
  userId: string,
  role: UserRole,
): Promise<AdminUserSummary> {
  const { user } = await api.patch<{ user: AdminUserSummary }>(
    `/admin/users/${encodeURIComponent(userId)}/role`,
    { role },
  );
  return user;
}

/**
 * `PATCH /admin/users/{id}/status`.
 *
 * Sends the **target state** (`active` / `banned` / `shadow_banned`), which is
 * how the shipped UI is designed and what the endpoint accepts. The backend
 * translates that into the right moderation verb — ban, shadow-ban, or a
 * reinstatement — and records the action. Deriving the verb here would be a
 * second semantics layer competing with the one that already exists.
 */
export async function updateUserStatus(
  userId: string,
  status: ModerationStatus,
  reason = "",
): Promise<{ statusChanged: boolean }> {
  return api.patch<{ statusChanged: boolean }>(
    `/admin/users/${encodeURIComponent(userId)}/status`,
    { status, reason },
  );
}

/* ── Audit log ────────────────────────────────────────────────────────────── */

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actor: { id: string; username: string; displayName: string } | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

/** `GET /admin/audit-logs` — platform-admin only. */
export async function getAuditLogs(
  params: { page?: number; limit?: number; action?: string } = {},
): Promise<OffsetPage<AuditLogEntry>> {
  return api.getPaginated<AuditLogEntry>("/admin/audit-logs", { query: { ...params } });
}

/* ── Moderation queue ─────────────────────────────────────────────────────── */

/**
 * A report as the API returns it.
 *
 * Two differences from the shipped `ReportWithDetails`, both the backend's
 * deliberate choices:
 *
 *  - **No `targetSummary`.** The queue does not serve a snippet of the
 *    reported content. Building one would mean joining five content tables per
 *    page and, worse, projecting the text of a private project or a direct
 *    message into a moderation response. Staff open the target to read it.
 *  - **`reporter` is nullable**, for a report whose reporter has since been
 *    deleted. The shipped type declared it non-null, which would have crashed
 *    the row on the first such report.
 */
export interface ModerationReport extends Report {
  reporter: ReportWithDetails["reporter"];
  targetAuthor: ReportWithDetails["targetAuthor"];
  reviewerId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
}

/** `GET /moderation/reports` — staff-only, offset-paginated. */
export async function getReports(
  params: { status?: ReportStatus; page?: number; limit?: number } = {},
): Promise<OffsetPage<ModerationReport>> {
  return api.getPaginated<ModerationReport>("/moderation/reports", {
    query: { ...params },
  });
}

/** `PATCH /moderation/reports/{id}` — closes or reopens one report. */
export async function updateReportStatus(
  reportId: string,
  status: ReportStatus,
  resolution?: string,
): Promise<ModerationReport> {
  const { report } = await api.patch<{ report: ModerationReport }>(
    `/moderation/reports/${encodeURIComponent(reportId)}`,
    { status, ...(resolution ? { resolution } : {}) },
  );
  return report;
}

/**
 * `POST /moderation/reports` — filing a report.
 *
 * Open to any authenticated user, unlike everything else in this file. It is
 * here rather than in a content service because the report workflow is one
 * domain, and the queue that receives these is right above.
 */
export async function submitReport(input: {
  targetType: Report["targetType"];
  targetId: string;
  reason: ReportReason;
  details?: string;
}): Promise<ModerationReport> {
  const { report } = await api.post<{ report: ModerationReport }>(
    "/moderation/reports",
    input,
  );
  return report;
}
