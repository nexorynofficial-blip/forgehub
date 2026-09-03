import type { FeedFilter } from "@/types";

/**
 * Query keys for server state.
 *
 * Centralised so a mutation and the query it invalidates cannot drift apart —
 * a typo in an inline array is a silently stale screen, not a build error.
 * `["currentUser"]` keeps the string the shipped components already used, so
 * nothing that reads it needs to change.
 *
 * Keys are grouped by domain and each domain shares a leading segment, so a
 * mutation can invalidate a whole domain (`["project"]`) or one entity
 * (`["project", slug]`) without either being a guess.
 */
export const queryKeys = {
  currentUser: ["currentUser"] as const,

  /* ── Users & social graph ───────────────────────────────────────────────── */
  profile: (username: string) => ["user", username] as const,
  followers: (username: string) => ["followers", username] as const,
  following: (username: string) => ["following", username] as const,
  relationship: (username: string) => ["relationship", username] as const,

  blockedUsers: ["blocked-users"] as const,
  userSettings: ["user-settings"] as const,
  notificationPreferences: ["notification-preferences"] as const,

  /* ── Projects ───────────────────────────────────────────────────────────── */
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  projectMembers: (slug: string) => ["project", slug, "members"] as const,
  projectUpdates: (slug: string) => ["project", slug, "updates"] as const,
  ownerProjects: (username: string) => ["owner-projects", username] as const,
  trendingProjects: ["trending-projects"] as const,

  /* ── Feed, posts & comments ─────────────────────────────────────────────── */
  feed: (filter: FeedFilter) => ["feed", filter] as const,
  post: (id: string) => ["post", id] as const,
  postComments: (postId: string) => ["post", postId, "comments"] as const,
  commentReplies: (commentId: string) => ["comment", commentId, "replies"] as const,
  bookmarks: ["bookmarks"] as const,

  /* ── Communities ────────────────────────────────────────────────────────── */
  communities: ["communities"] as const,
  community: (slug: string) => ["community", slug] as const,
  communityMembers: (slug: string) => ["community", slug, "members"] as const,
  communityModerators: (slug: string) => ["community", slug, "moderators"] as const,
  communityPosts: (slug: string) => ["community", slug, "posts"] as const,
  communityPins: (slug: string) => ["community", slug, "pins"] as const,
  communityEvents: (slug: string) => ["community", slug, "events"] as const,

  /* ── Messaging ──────────────────────────────────────────────────────────── */
  conversations: ["conversations"] as const,
  conversation: (id: string) => ["conversation", id] as const,
  messages: (conversationId: string) =>
    ["conversation", conversationId, "messages"] as const,

  /* ── Notifications ──────────────────────────────────────────────────────── */
  notifications: ["notifications"] as const,
  unreadNotifications: ["notifications", "unread"] as const,

  /* ── Search ─────────────────────────────────────────────────────────────── */
  search: (query: string, type: string) => ["search", type, query] as const,

  /* ── Moderation & admin ─────────────────────────────────────────────────── */
  adminStats: ["admin", "stats"] as const,
  adminUsers: ["admin", "users"] as const,
  adminSignups: ["admin", "signups"] as const,
  adminReportsByReason: ["admin", "reports-by-reason"] as const,
  adminAuditLogs: ["admin", "audit-logs"] as const,
  reports: (status?: string) => ["moderation", "reports", status ?? "all"] as const,
} as const;
