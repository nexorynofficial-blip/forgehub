import type { NotificationType } from "@prisma/client";

/**
 * Notification authorization and suppression, as pure functions.
 *
 * No Prisma import and no I/O. The service gathers the facts — the recipient's
 * preference row, the block relationship, whether an identical notification is
 * already waiting unread — and this file decides. The same split
 * `message.access.ts` and `community.access.ts` use, and for the same reason:
 * an authorization matrix that can be exercised exhaustively without a
 * database is one that actually gets exercised exhaustively.
 *
 * Four rules suppress a notification, and their **order is a security
 * decision**, asserted in the tests rather than merely commented:
 *
 *   1. **Self.** You are never notified about your own action.
 *   2. **Blocking, either direction.** Consistent with Phases 4–8, where a
 *      block outranks membership, ownership, and admin role. A notification is
 *      a channel from an actor to a recipient, so a block must close it —
 *      otherwise blocking someone would still let them put text in front of
 *      you every time they liked something of yours.
 *   3. **The recipient's `inApp` preference.** `false` means the row is never
 *      written at all, not merely hidden on read. A stored-but-invisible
 *      notification would still be a record of activity the user asked not to
 *      be told about.
 *   4. **Collapse.** See `shouldCollapse`.
 *
 * Self and blocking come before the preference lookup so the common refusals
 * cost no query, and before collapse so a suppressed event never consults
 * history it has no business reading.
 */

/* ── Suppression ─────────────────────────────────────────────────────────── */

export interface DeliveryContext {
  recipientId: string;
  actorId: string | null;
  /** What kind of notification this is. Decides whether rules 3 and 4 apply. */
  type: NotificationType;
  /** A `Block` exists in either direction between actor and recipient. */
  blockedEitherWay: boolean;
  /** The recipient's `inApp` flag for this type. Defaults to true upstream. */
  inAppEnabled: boolean;
  /**
   * An identical notification is already sitting unread in the recipient's
   * list — same type, same actor, same target.
   */
  duplicateUnread: boolean;
}

/**
 * Types that are delivered whatever the recipient's settings say (Phase 11,
 * ruling R11).
 *
 * `moderation` alone. A warning, a suspension, a ban, and a content removal
 * are outcomes a person is *entitled to be told about*, not activity updates
 * they opted into — and a user who muted the type would otherwise discover
 * their account was banned by failing to log in. ARCHITECTURE §25 makes the
 * moderation flow end at the affected user for a reason.
 *
 * This does **not** bypass the self or block rules, and does not need to.
 * Moderation notifications are raised with no actor at all (see
 * `notification.port.ts`), so neither rule can apply to them in the first
 * place — the guarantee is structural rather than a second exemption.
 */
export const UNSUPPRESSIBLE_TYPES: readonly NotificationType[] = ["moderation"];

export function isUnsuppressible(type: NotificationType): boolean {
  return UNSUPPRESSIBLE_TYPES.includes(type);
}

/**
 * Why a notification was not delivered.
 *
 * A reason rather than a bare boolean, because unlike a *read* authorization
 * decision this one is never shown to anyone — it exists for tests and debug
 * logging, so there is no disclosure risk in being specific.
 */
export type SuppressionReason = "self" | "blocked" | "preference" | "duplicate";

export type DeliveryDecision =
  { deliver: true } | { deliver: false; reason: SuppressionReason };

export function resolveDelivery(context: DeliveryContext): DeliveryDecision {
  // A system notification has no actor, so neither the self nor the block rule
  // can apply. Written as an explicit branch rather than relying on
  // `null !== recipientId` happening to be true.
  if (context.actorId !== null) {
    if (context.actorId === context.recipientId) {
      return { deliver: false, reason: "self" };
    }
    if (context.blockedEitherWay) {
      return { deliver: false, reason: "blocked" };
    }
  }

  // Moderation outcomes are not optional reading. Placed after the self and
  // block checks rather than before them so the exemption can only ever widen
  // delivery to the *affected user*, never turn a notification back on for
  // someone the recipient blocked.
  if (isUnsuppressible(context.type)) return { deliver: true };

  if (!context.inAppEnabled) return { deliver: false, reason: "preference" };
  if (context.duplicateUnread) return { deliver: false, reason: "duplicate" };

  return { deliver: true };
}

/**
 * The deduplication rule: **collapse while unread**.
 *
 * The specification is silent on deduplication — no PRD, TRD, or ARCHITECTURE
 * line addresses it, and the schema carries no unique constraint that could
 * arbitrate one. So this is a deliberate product decision, and it is stated
 * here rather than buried in a query.
 *
 * The rule: an identical notification (same recipient, type, actor, and
 * target) is suppressed **if the previous one has not been read yet**. Once
 * the recipient has read it, the next occurrence is genuinely new information
 * and gets its own row.
 *
 * Why this shape and not a time window:
 *
 *   - It needs no tuning constant. "Five minutes" would be arbitrary and would
 *     be wrong for both a rapid like/unlike/like and a conversation that goes
 *     quiet for an hour.
 *   - It is self-limiting in exactly the case that matters. Twenty messages in
 *     one conversation collapse to one unread badge entry; open the thread and
 *     the next message notifies again.
 *   - It is explainable to a user in one sentence, which a decay window is not.
 *
 * Known limit, accepted: two *simultaneous* identical events can both pass the
 * check, because no unique index exists to arbitrate and adding one would be a
 * schema change this phase is not permitted to make. The outcome is one
 * redundant row, which is a cosmetic defect rather than a correctness or
 * security one.
 */
export function shouldCollapse(hasUnreadDuplicate: boolean): boolean {
  return hasUnreadDuplicate;
}

/**
 * Notification types that are **not** collapsed.
 *
 * An invitation is a distinct act each time, and a project update is a
 * distinct piece of content — receiving two and being told about one would
 * lose information rather than reduce noise. Likes, comments, replies,
 * mentions, follows, and messages all describe repeatable activity where the
 * second occurrence adds nothing the first did not already say.
 */
export const NON_COLLAPSING_TYPES: readonly NotificationType[] = [
  "project_invite",
  "community_invite",
  "invite",
  "project_update",
  // Phase 11. Each moderation action is a distinct decision, on the same
  // reasoning as an invitation: two warnings collapsed into one would tell the
  // recipient they had been warned once. `resolveDelivery` already exempts the
  // type from collapse; this keeps the two rules from disagreeing if that
  // exemption is ever narrowed.
  "moderation",
];

export function collapses(type: NotificationType): boolean {
  return !NON_COLLAPSING_TYPES.includes(type);
}

/* ── Ownership ───────────────────────────────────────────────────────────── */

export interface NotificationOwnershipContext {
  /** The row exists at all. */
  exists: boolean;
  /** `Notification.userId`. */
  recipientId: string | null;
  /** The authenticated caller. */
  viewerId: string;
}

/**
 * Whether the caller may read or mutate this notification.
 *
 * Returns a bare boolean with no reason code, deliberately: a caller able to
 * distinguish "not yours" from "does not exist" is one `if` away from leaking
 * that difference, and the service turns every `false` into the same 404.
 *
 * There is no admin branch. A platform admin reading another user's
 * notification list would be reading a digest of their private activity —
 * every like, mention, and message they have received. Phases 4–8 kept admin
 * out of ordinary social surfaces, and this is a more sensitive surface than
 * any of them.
 */
export function canAccessNotification(context: NotificationOwnershipContext): boolean {
  if (!context.exists) return false;
  if (context.recipientId === null) return false;
  return context.recipientId === context.viewerId;
}

/* ── Read state ──────────────────────────────────────────────────────────── */

/**
 * Whether marking read should actually write.
 *
 * Marking an already-read notification is a no-op rather than an error: the
 * caller asked for a state that already holds, and re-stamping `readAt` would
 * rewrite history to say they read it later than they did.
 */
export function shouldMarkRead(currentlyRead: boolean): boolean {
  return !currentlyRead;
}

/* ── Fan-out bounds ──────────────────────────────────────────────────────── */

/**
 * Caps on `project_update`, the one notification in this phase that is a
 * fan-out rather than a single delivery.
 *
 * ARCHITECTURE lists notification fan-out among the operations that *may* run
 * as a background job, and TRD §25 makes the job infrastructure optional
 * ("may be used"). No queue library is installed and this phase adds no
 * dependencies, so the fan-out runs inline — which makes bounding it a
 * correctness requirement rather than a nicety: an unbounded loop inside a
 * request would let a popular project turn one POST into tens of thousands of
 * inserts while the client waits.
 *
 * `FANOUT_BATCH_SIZE` is what one `createMany` handles at a time;
 * `FANOUT_MAX_RECIPIENTS` is the hard ceiling per event. Beyond the ceiling
 * the remaining followers simply are not notified in-app — they still see the
 * update on the project itself, which is where project updates are read.
 * Raising the ceiling is a Phase 12+ conversation about a real queue.
 */
export const FANOUT_BATCH_SIZE = 100;
export const FANOUT_MAX_RECIPIENTS = 500;

/** Splits recipients into bounded batches, applying the ceiling first. */
export function planFanout(recipientIds: readonly string[]): string[][] {
  const capped = recipientIds.slice(0, FANOUT_MAX_RECIPIENTS);
  const batches: string[][] = [];

  for (let index = 0; index < capped.length; index += FANOUT_BATCH_SIZE) {
    batches.push(capped.slice(index, index + FANOUT_BATCH_SIZE));
  }

  return batches;
}
