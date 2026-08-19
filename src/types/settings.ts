import type { NotificationType } from "./notification";

/** Presentation-layer types for Settings (Phase 10). */

export interface NotificationChannelPreference {
  inApp: boolean;
  email: boolean;
}

/** PRD.md §4.8 Notifications, one row per type. */
export type NotificationPreferences = Record<
  NotificationType,
  NotificationChannelPreference
>;

export type ProfileVisibility = "public" | "followers";
export type MessagePermission = "everyone" | "followers";

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  showEmailOnProfile: boolean;
  whoCanMessage: MessagePermission;
  twoFactorEnabled: boolean;
}
