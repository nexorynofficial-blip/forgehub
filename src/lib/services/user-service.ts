import type { User } from "@/types";
import { api } from "@/lib/api";

/**
 * The caller's own account (`backend/src/modules/users`).
 *
 * Distinct from `profile-service`, which reads *other* people's profiles: the
 * shapes differ (your own record always carries your email; someone else's may
 * withhold it) and so do the permissions.
 */

/**
 * `GET /users/me` returns the backend's `CurrentUserView` — every field of the
 * frontend's `User`, plus three owner-only extras.
 *
 * `email` is the reason this is a distinct type from `PublicUser`: on your own
 * record the backend always includes it, so `User.email` stays a required
 * string exactly as the settings form expects.
 */
export interface CurrentUser extends User {
  emailVerified: boolean;
  /** 0-100, drives profile-completion prompts. Never shown on other profiles. */
  profileCompletion: number;
  profileVisibility: "public" | "followers";
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const { user } = await api.get<{ user: CurrentUser }>("/users/me");
  return user;
}

/**
 * The fields `PATCH /users/me` accepts.
 *
 * Narrower than `Partial<User>` on purpose: counters, reputation, achievements
 * and badges are server-owned and have no write path, so allowing them in the
 * type would invite a call that silently does nothing. `username` *is* here —
 * the backend's `updateProfileSchema` accepts it and routes it through the
 * same rename path as the dedicated endpoint, which is what lets the shipped
 * account form keep posting one payload.
 */
export interface ProfilePatch {
  displayName?: string;
  username?: string;
  /** Accepted, but the backend refuses an actual *change* — see below. */
  email?: string;
  bio?: string;
  location?: string | null;
  websiteUrl?: string | null;
  experienceYears?: number | null;
  skills?: string[];
  techStack?: string[];
  socialLinks?: { platform: string; url: string }[];
}

/**
 * `PATCH /users/me`.
 *
 * A note on `email`: the shipped form posts it, and the backend accepts the
 * field but answers 422 if the value actually differs, because changing an
 * address is a credential operation needing re-verification. Sending the
 * unchanged current value — which the form does — is a no-op, so the field is
 * passed through rather than stripped. Stripping it would hide a real 422 the
 * user should see if they edit that input.
 */
export async function updateCurrentUser(patch: ProfilePatch): Promise<CurrentUser> {
  const { user } = await api.patch<{ user: CurrentUser }>("/users/me", patch);
  return user;
}

/**
 * `PATCH /users/me/username` — the standalone rename, for callers that change
 * only the handle. Returns just the new username.
 *
 * The session survives: the access token carries a user id and session id, not
 * a handle. What does *not* survive is a cached copy of the old username, so
 * callers must refresh the session user (see `AuthProvider.updateSessionUser`).
 */
export async function updateUsername(username: string): Promise<{ username: string }> {
  return api.patch<{ username: string }>("/users/me/username", { username });
}

/**
 * `POST /auth/password/change`.
 *
 * The backend's `changePasswordSchema` requires all three fields and re-checks
 * that the two new ones match, so the confirmation is passed through rather
 * than dropped — the server is the authority on that comparison, not the form.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
  confirmNewPassword: string,
): Promise<{ success: true }> {
  await api.post("/auth/password/change", {
    currentPassword,
    newPassword,
    confirmNewPassword,
  });
  return { success: true };
}
