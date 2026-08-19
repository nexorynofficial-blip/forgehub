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
import { mockAdminUsers } from "@/lib/mock/admin-users";
import { mockWeeklySignups } from "@/lib/mock/analytics";
import { mockCommunities } from "@/lib/mock/communities";
import { mockPlatformStats } from "@/lib/mock/stats";
import { resolvePersonById } from "@/lib/mock/people";
import { mockProjects } from "@/lib/mock/projects";
import { mockPosts } from "@/lib/mock/posts";
import { mockCommentsByPostId } from "@/lib/mock/comments";
import { mockReports } from "@/lib/mock/reports";

/** Placeholder for the Moderation/Analytics APIs (TRD.md §5). */

function resolveTargetSummary(report: Report): string {
  switch (report.targetType) {
    case "post": {
      const post = mockPosts.find((p) => p.id === report.targetId);
      return post ? post.content : "Post no longer available";
    }
    case "comment": {
      const comment = Object.values(mockCommentsByPostId)
        .flat()
        .find((c) => c.id === report.targetId);
      return comment ? comment.content : "Comment no longer available";
    }
    case "project": {
      const project = mockProjects.find((p) => p.id === report.targetId);
      return project ? project.title : "Project no longer available";
    }
    case "community": {
      const community = mockCommunities.find((c) => c.id === report.targetId);
      return community ? community.name : "Community no longer available";
    }
    case "user": {
      const person = resolvePersonById(report.targetId);
      return person ? `@${person.username}` : "User no longer available";
    }
    default:
      return "";
  }
}

export async function getOverviewStats(): Promise<AdminOverviewStats> {
  return {
    totalUsers: mockPlatformStats.builderCount,
    totalProjects: mockPlatformStats.projectCount,
    totalCommunities: mockCommunities.length,
    pendingReportsCount: mockReports.filter((r) => r.status === "pending").length,
  };
}

export async function getReports(
  statusFilter?: ReportStatus,
): Promise<ReportWithDetails[]> {
  return mockReports
    .filter((report) => !statusFilter || report.status === statusFilter)
    .map((report) => {
      const reporter = resolvePersonById(report.reporterId);
      if (!reporter) return null;
      return {
        ...report,
        reporter,
        targetAuthor: report.targetAuthorId
          ? resolvePersonById(report.targetAuthorId)
          : null,
        targetSummary: resolveTargetSummary(report),
      };
    })
    .filter((report): report is ReportWithDetails => report !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export async function updateReportStatus(
  reportId: string,
  status: ReportStatus,
): Promise<void> {
  const report = mockReports.find((r) => r.id === reportId);
  if (report) report.status = status;
}

export async function getAdminUsers(): Promise<AdminUserSummary[]> {
  return [...mockAdminUsers];
}

export async function getRecentlyJoinedUsers(limit = 4): Promise<AdminUserSummary[]> {
  return [...mockAdminUsers]
    .sort((a, b) => new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime())
    .slice(0, limit);
}

export async function getWeeklySignups(): Promise<
  { weekLabel: string; count: number }[]
> {
  return mockWeeklySignups;
}

const REASON_ORDER: ReportReason[] = [
  "spam",
  "harassment",
  "inappropriate_content",
  "impersonation",
  "other",
];

export async function getReportsByReason(): Promise<
  { reason: ReportReason; count: number }[]
> {
  return REASON_ORDER.map((reason) => ({
    reason,
    count: mockReports.filter((r) => r.reason === reason).length,
  })).filter((row) => row.count > 0);
}

export async function updateUserRole(userId: string, role: UserRole): Promise<void> {
  const entry = mockAdminUsers.find((u) => u.user.id === userId);
  if (entry) entry.role = role;
}

export async function updateUserStatus(
  userId: string,
  status: ModerationStatus,
): Promise<void> {
  const entry = mockAdminUsers.find((u) => u.user.id === userId);
  if (entry) entry.status = status;
}
