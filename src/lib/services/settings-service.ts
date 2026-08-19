import type {
  FollowerPreview,
  NotificationPreferences,
  NotificationType,
  PrivacySettings,
} from "@/types";
import {
  mockBlockedUsers,
  mockNotificationPreferences,
  mockPrivacySettings,
} from "@/lib/mock/settings";

/** Placeholder for the Settings/Profile API (TRD.md §5). Every getter below
 * returns a fresh top-level reference (shallow copy) rather than the
 * mutated-in-place mock object/array directly — otherwise React Query sees
 * the same reference after a refetch and won't re-render subscribers, even
 * though the underlying values changed. See docs/ASSUMPTIONS.md (Phase 10). */

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return { ...mockNotificationPreferences };
}

export async function updateNotificationPreference(
  type: NotificationType,
  channel: "inApp" | "email",
  value: boolean,
): Promise<NotificationPreferences> {
  mockNotificationPreferences[type][channel] = value;
  return { ...mockNotificationPreferences };
}

export async function getPrivacySettings(): Promise<PrivacySettings> {
  return { ...mockPrivacySettings };
}

export async function updatePrivacySettings(
  patch: Partial<PrivacySettings>,
): Promise<PrivacySettings> {
  Object.assign(mockPrivacySettings, patch);
  return { ...mockPrivacySettings };
}

export async function getBlockedUsers(): Promise<FollowerPreview[]> {
  return [...mockBlockedUsers];
}

export async function unblockUser(userId: string): Promise<FollowerPreview[]> {
  const index = mockBlockedUsers.findIndex((user) => user.id === userId);
  if (index !== -1) mockBlockedUsers.splice(index, 1);
  return [...mockBlockedUsers];
}
