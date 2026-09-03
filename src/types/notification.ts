import type { ID, ISODateString } from "./common";

/**
 * PRD.md §4.8 Notifications — every type the API can return.
 *
 * The persisted enum has twelve values and `GET /notifications` returns
 * whichever is stored, so a union of eight would let the other four fall
 * through an icon or label lookup and render blank. `reply`, `project_invite`,
 * `community_invite` and `moderation` are the four the original union omitted.
 */
export type NotificationType =
  | "like"
  | "comment"
  | "reply"
  | "mention"
  | "follower"
  | "project_update"
  | "invite"
  | "project_invite"
  | "community_invite"
  | "message"
  | "achievement"
  | "moderation";

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
