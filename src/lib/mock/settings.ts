import type { FollowerPreview, NotificationPreferences, PrivacySettings } from "@/types";

export const mockNotificationPreferences: NotificationPreferences = {
  like: { inApp: true, email: false },
  comment: { inApp: true, email: true },
  mention: { inApp: true, email: true },
  follower: { inApp: true, email: false },
  project_update: { inApp: true, email: true },
  invite: { inApp: true, email: true },
  message: { inApp: true, email: false },
  achievement: { inApp: true, email: false },
};

export const mockPrivacySettings: PrivacySettings = {
  profileVisibility: "public",
  showEmailOnProfile: false,
  whoCanMessage: "everyone",
  twoFactorEnabled: false,
};

/** Empty by default — demonstrates `BlockedUsersList`'s empty state; see
 * docs/ASSUMPTIONS.md (Phase 10). */
export const mockBlockedUsers: FollowerPreview[] = [];
