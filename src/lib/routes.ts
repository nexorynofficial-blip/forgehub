/**
 * Central route registry for the whole app. Every phase (02-11) reads its
 * paths from here instead of hardcoding strings, so the route map stays a
 * single source of truth as pages come online phase by phase.
 *
 * Only "/" is wired to a real page in this (Project Setup) phase. Every
 * other entry documents where a future phase's pages will live; the
 * corresponding route segments are created when that phase is implemented,
 * not before — see docs/ARCHITECTURE.md.
 */
export const routes = {
  home: "/",

  auth: {
    login: "/login",
    signup: "/signup",
    forgotPassword: "/forgot-password",
    // Where the emailed reset link lands (backend `APP_URL/reset-password`).
    resetPassword: "/reset-password",
    verifyEmail: "/verify-email",
    twoFactor: "/2fa",
    // Where the backend sends the browser after Google, success or failure.
    // The backend names the same path in `auth.frontend-routes.ts`; the two
    // must move together.
    googleCallback: "/auth/google/callback",
  },

  dashboard: "/dashboard",

  profile: (username: string) => `/profile/${username}`,

  feed: "/feed",

  project: (projectId: string) => `/projects/${projectId}`,
  newProject: "/projects/new",

  communities: "/communities",
  community: (communityId: string) => `/communities/${communityId}`,

  messages: "/messages",
  conversation: (conversationId: string) => `/messages/${conversationId}`,

  settings: {
    account: "/settings/account",
    appearance: "/settings/appearance",
    privacy: "/settings/privacy",
    notifications: "/settings/notifications",
  },

  admin: {
    root: "/admin",
    reports: "/admin/reports",
    users: "/admin/users",
    analytics: "/admin/analytics",
  },
} as const;
