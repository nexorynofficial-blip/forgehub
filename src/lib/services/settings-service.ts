import type {
  FollowerPreview,
  NotificationPreferences,
  NotificationType,
  PrivacySettings,
} from "@/types";
import { api } from "@/lib/api";
import {
  getBlockedUsers as fetchBlockedUsers,
  unblockUser as unblockByUsername,
} from "@/lib/services/follows-service";

/**
 * Settings (`backend/src/modules/users`).
 *
 * The backend's `PrivacySettingsView` and `NotificationPreferencesView` were
 * written to mirror the frontend's `PrivacySettings` and
 * `NotificationPreferences` exactly, so these need no field mapping — only
 * unwrapping the `{ settings }` / `{ preferences }` envelope key.
 */

/** How many blocked accounts the settings list shows in one page. */
const BLOCKED_PAGE_SIZE = 50;

/* ── Privacy ──────────────────────────────────────────────────────────────── */

export async function getPrivacySettings(): Promise<PrivacySettings> {
  const { settings } = await api.get<{ settings: PrivacySettings }>("/users/me/settings");
  return settings;
}

/**
 * `PATCH /users/me/settings`.
 *
 * `twoFactorEnabled` is readable here but not writable: the backend refuses it
 * because enabling 2FA requires proving you hold the authenticator. It is
 * stripped rather than forwarded so a stale form value cannot turn a settings
 * save into a 422.
 */
export async function updatePrivacySettings(
  patch: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  const writable: Record<string, unknown> = {};
  if (patch.profileVisibility !== undefined) {
    writable["profileVisibility"] = patch.profileVisibility;
  }
  if (patch.showEmailOnProfile !== undefined) {
    writable["showEmailOnProfile"] = patch.showEmailOnProfile;
  }
  if (patch.whoCanMessage !== undefined) writable["whoCanMessage"] = patch.whoCanMessage;

  const { settings } = await api.patch<{ settings: PrivacySettings }>(
    "/users/me/settings",
    writable,
  );
  return settings;
}

/* ── Notification preferences ─────────────────────────────────────────────── */

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const { preferences } = await api.get<{ preferences: NotificationPreferences }>(
    "/users/me/notification-preferences",
  );
  return preferences;
}

/**
 * `PATCH /users/me/notification-preferences` — one row of the matrix.
 *
 * The backend takes `{ type, inApp?, email? }` and requires at least one
 * channel, which is exactly this call shape. It returns the whole updated
 * matrix, so the caller never has to merge locally.
 */
export async function updateNotificationPreference(
  type: NotificationType,
  channel: "inApp" | "email",
  value: boolean,
): Promise<NotificationPreferences> {
  const { preferences } = await api.patch<{ preferences: NotificationPreferences }>(
    "/users/me/notification-preferences",
    { type, [channel]: value },
  );
  return preferences;
}

/* ── Blocked accounts ─────────────────────────────────────────────────────── */

/**
 * `GET /users/me/blocks`.
 *
 * Cursor-paginated server-side; the settings panel renders one bounded page
 * rather than paging to exhaustion.
 */
export async function getBlockedUsers(): Promise<FollowerPreview[]> {
  const page = await fetchBlockedUsers({ limit: BLOCKED_PAGE_SIZE });
  return page.items;
}

/**
 * `DELETE /users/{username}/block`.
 *
 * Takes a **username**, not an id: the route is addressed by handle. The old
 * mock signature took a `userId`, which had no route to send it to — every
 * blocked-user record already carries `username`, so the call site passes that
 * instead. Returns the refreshed list, preserving the previous contract.
 */
export async function unblockUser(username: string): Promise<FollowerPreview[]> {
  await unblockByUsername(username);
  return getBlockedUsers();
}
