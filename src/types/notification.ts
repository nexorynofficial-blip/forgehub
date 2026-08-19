import type { ID, ISODateString } from "./common";

/** PRD.md §4.8 Notifications */
export type NotificationType =
  | "like"
  | "comment"
  | "mention"
  | "follower"
  | "project_update"
  | "invite"
  | "message"
  | "achievement";

export interface Notification {
  id: ID;
  userId: ID;
  type: NotificationType;
  actorId: ID | null;
  targetId: ID | null;
  message: string;
  isRead: boolean;
  createdAt: ISODateString;
}
