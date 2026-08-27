import type { NotificationType } from "@prisma/client";

/**
 * Notification text, rendered at write time.
 *
 * The schema says why: *"Rendered at write time so the list needs no per-row
 * joins to display."* `Notification.message` is a stored string, not a
 * template resolved on read, which means the panel renders from one indexed
 * query with no fan-out of lookups per row.
 *
 * The consequence is worth stating plainly: **the text is a snapshot.** If an
 * actor later changes their display name, old notifications keep the name they
 * had at the time. That is the correct behaviour for a timeline of past events
 * — a notification describes something that happened, and rewriting it to
 * match a later state would be a small lie — but it is a consequence of the
 * schema's design rather than an independent choice, so it is documented
 * rather than defended.
 *
 * This file is pure: no I/O, no Prisma. The service supplies the actor's name
 * and the subject; this decides the wording.
 */

/** What the notification text needs to describe an event. */
export interface MessageContext {
  type: NotificationType;
  /** The actor's display name, or null for a system notification. */
  actorName: string | null;
  /**
   * A short label for the thing acted upon — a project name, a community
   * name. Optional: most types read fine without one, and forcing a subject
   * would mean a database lookup per notification at write time.
   */
  subject?: string | null;
}

/** Falls back to a neutral third person rather than leaking "null". */
const SOMEONE = "Someone";

function actor(context: MessageContext): string {
  const name = context.actorName?.trim();
  return name !== undefined && name.length > 0 ? name : SOMEONE;
}

function withSubject(base: string, subject: string | null | undefined): string {
  const trimmed = subject?.trim();
  if (trimmed === undefined || trimmed.length === 0) return `${base}.`;
  return `${base} ${trimmed}.`;
}

/**
 * Renders one notification's text.
 *
 * The `switch` is exhaustive over `NotificationType` with no `default`. If the
 * schema ever gains a thirteenth member this stops compiling, which is the
 * point — the alternative is a new type silently rendering as empty text in
 * everyone's notification panel.
 *
 * `achievement` and `moderation` are handled here even though **no code path
 * in this phase produces them**: the awarding engine is Phase 10 and
 * moderation actions are Phase 11. They are covered so the exhaustiveness
 * check passes honestly rather than by casting, and so those phases inherit
 * wording instead of inventing it.
 */
export function renderNotificationMessage(context: MessageContext): string {
  const who = actor(context);

  switch (context.type) {
    case "like":
      return withSubject(`${who} liked your`, context.subject ?? "post");
    case "comment":
      return `${who} commented on your post.`;
    case "reply":
      return `${who} replied to your comment.`;
    case "mention":
      return `${who} mentioned you.`;
    case "follower":
      return `${who} started following you.`;
    case "project_update":
      return withSubject(`${who} posted an update to`, context.subject);
    case "invite":
      return withSubject(`${who} invited you to`, context.subject);
    case "project_invite":
      return withSubject(`${who} added you to the project`, context.subject);
    case "community_invite":
      return withSubject(`${who} added you to the community`, context.subject);
    case "message":
      return `${who} sent you a message.`;
    case "achievement":
      return withSubject("You earned a new achievement:", context.subject);
    case "moderation":
      return withSubject("A moderator took action on your content:", context.subject);
  }
}

/**
 * Hard ceiling on the stored string.
 *
 * `Notification.message` is an unbounded `String` column, and the only inputs
 * that vary are a display name and a subject — both already bounded by their
 * own schemas. This is belt and braces so a future caller passing an
 * unvalidated subject cannot write an arbitrarily large row.
 */
export const MAX_MESSAGE_LENGTH = 300;

export function clampMessage(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}
