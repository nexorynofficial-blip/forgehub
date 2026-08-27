import type { MessagePermission } from "@prisma/client";

/**
 * Messaging authorization, as pure functions (BACKEND_TRD.md §20).
 *
 * Every rule that decides *whether* something is allowed lives here, with no
 * Prisma import and no I/O. The service gathers the facts — membership, block
 * rows, the recipient's setting — and this file decides. That split is what
 * makes the authorization matrix exhaustively unit-testable, the same shape
 * `community.access.ts` and `post.visibility.ts` use.
 *
 * The ordering of the checks is itself a security decision and is asserted in
 * the tests, not merely commented:
 *
 *   1. **Blocking outranks everything.** Not membership, not an existing
 *      conversation, not a permissive `whoCanMessage`. Phase 4 set this
 *      precedent and Phases 5–7 carried it; messaging is where it matters
 *      most, because a conversation predating the block would otherwise stay
 *      open as a channel to someone who has explicitly refused contact.
 *   2. **Membership, from the database.** Never from a socket room, never from
 *      a client claim.
 *   3. **`whoCanMessage`**, which is a *contact* policy and therefore the last
 *      gate, not the first.
 */

/* ── Conversation access ─────────────────────────────────────────────────── */

/**
 * What the service knows about a viewer's standing in one conversation.
 *
 * `blockedEitherWay` is deliberately a single boolean rather than a direction:
 * the outcome is identical whichever way the block runs, and collapsing it
 * here removes the temptation to write a rule that treats "I blocked them" as
 * less disqualifying than "they blocked me".
 */
export interface ConversationAccessContext {
  /** Conversation row exists and is not soft-deleted. */
  exists: boolean;
  /** The viewer holds a live `ConversationMember` row (`leftAt` is null). */
  isMember: boolean;
  /** A `Block` exists in either direction with any other participant. */
  blockedEitherWay: boolean;
}

/**
 * The single verdict every conversation-scoped operation consults.
 *
 * Returns a boolean rather than throwing so it stays pure; the service turns a
 * `false` into the project's canonical 404. There is deliberately no "403"
 * outcome and no reason code in the return value — a caller that could
 * distinguish "not a member" from "does not exist" would be one `if` away from
 * leaking that difference to a client.
 */
export function canAccessConversation(context: ConversationAccessContext): boolean {
  if (!context.exists) return false;
  if (context.blockedEitherWay) return false;
  return context.isMember;
}

/* ── Starting a conversation ─────────────────────────────────────────────── */

/**
 * Facts about the *recipient* of a conversation request.
 *
 * `requesterFollowsRecipient` is named from the requester's side on purpose.
 * "Who can message you → Followers only" (`privacy-form.tsx`) means *my
 * followers*, so the edge that matters runs requester → recipient. Naming it
 * `isFollowing` would leave the direction to the reader and the direction is
 * the entire rule.
 */
export interface DirectMessageContext {
  /** Recipient exists, is not soft-deleted, and is not banned. */
  recipientExists: boolean;
  /** The requester and the recipient are the same account. */
  isSelf: boolean;
  blockedEitherWay: boolean;
  recipientPolicy: MessagePermission;
  requesterFollowsRecipient: boolean;
  /** The requester holds a platform-wide admin role. */
  requesterIsAdmin: boolean;
}

/**
 * Why a direct message was refused.
 *
 * The service maps every one of these to a response, and the mapping is not
 * one-to-one on purpose — see `MESSAGING.md`. `blocked` and `not_found` both
 * become a 404, because a distinct "you are blocked" would tell the requester
 * something the person who blocked them chose not to share.
 */
export type DirectMessageRefusal = "not_found" | "blocked" | "self" | "policy";

export type DirectMessageDecision =
  { allowed: true } | { allowed: false; reason: DirectMessageRefusal };

/**
 * Whether the requester may open (or continue) a direct conversation.
 *
 * Note what an admin role does **not** do: it does not bypass a block, and it
 * does not bypass `whoCanMessage`. Phases 4–7 kept platform admin out of
 * ordinary social surfaces — an admin reads a private profile but cannot
 * follow on someone's behalf — and messaging is a strictly more sensitive
 * surface than a profile read. `requesterIsAdmin` is carried in the context
 * only so this file can state that refusal explicitly rather than by omission;
 * a future moderation phase that wants admin messaging has to change this
 * function and its tests, which is the point.
 */
export function canStartDirectConversation(
  context: DirectMessageContext,
): DirectMessageDecision {
  if (!context.recipientExists) return { allowed: false, reason: "not_found" };

  // Before the self check: a self-block is impossible, but ordering this way
  // means no future edit can slip a disclosure in ahead of the block gate.
  if (context.blockedEitherWay) return { allowed: false, reason: "blocked" };

  if (context.isSelf) return { allowed: false, reason: "self" };

  if (satisfiesMessagePolicy(context)) return { allowed: true };

  return { allowed: false, reason: "policy" };
}

/**
 * The `whoCanMessage` matrix, isolated so the enum is handled exhaustively.
 *
 * The `switch` has no `default`. `MessagePermission` has exactly two members
 * today (`everyone`, `followers`); if a third is ever added to the schema,
 * this stops compiling instead of silently falling through to "allowed",
 * which is the failure mode worth engineering against.
 */
export function satisfiesMessagePolicy(
  context: Pick<
    DirectMessageContext,
    "recipientPolicy" | "requesterFollowsRecipient" | "requesterIsAdmin"
  >,
): boolean {
  switch (context.recipientPolicy) {
    case "everyone":
      return true;
    case "followers":
      return context.requesterFollowsRecipient;
  }
}

/* ── Message-level rules ─────────────────────────────────────────────────── */

export interface MessageOwnershipContext {
  senderId: string;
  actorId: string;
  deleted: boolean;
}

/**
 * Editing is the author's alone.
 *
 * No admin branch, and no moderator branch: rewriting someone else's words is
 * not a moderation power any specification in this project grants. Removal is
 * the moderation primitive, and it belongs to Phase 11.
 */
export function canEditMessage(context: MessageOwnershipContext): boolean {
  if (context.deleted) return false;
  return context.senderId === context.actorId;
}

/**
 * Deletion is the author's alone, matching the brief: *"do not allow users to
 * delete another user's message unless the existing product specification
 * explicitly grants that permission"*. No specification does. PRD §17 gives
 * moderators content removal, but that is the Phase 11 moderation surface with
 * its own audit trail — it must not arrive by accident through a DM endpoint.
 */
export function canDeleteMessage(context: MessageOwnershipContext): boolean {
  if (context.deleted) return false;
  return context.senderId === context.actorId;
}

/* ── Read watermarks ─────────────────────────────────────────────────────── */

/**
 * Whether a read watermark may move to `candidateAt`.
 *
 * Watermarks are **monotonic**. Two clients on the same account — a phone
 * scrolled to the top of the thread and a laptop at the bottom — will race,
 * and without this rule the phone's late-arriving "I read up to here" would
 * drag the watermark backwards and resurrect messages the laptop already
 * cleared. Unread counts would then oscillate for no reason the user can see.
 */
export function shouldAdvanceWatermark(
  currentAt: Date | null,
  candidateAt: Date,
): boolean {
  if (currentAt === null) return true;
  return candidateAt.getTime() > currentAt.getTime();
}

/**
 * Whether `memberLastReadAt` proves the member has seen a message sent at
 * `messageCreatedAt`.
 *
 * `>=` rather than `>`: marking a conversation read stores the newest
 * message's own `createdAt`, so an exclusive comparison would report that
 * very message as unseen by the person who just read it.
 */
export function hasSeenMessage(
  memberLastReadAt: Date | null,
  messageCreatedAt: Date,
): boolean {
  if (memberLastReadAt === null) return false;
  return memberLastReadAt.getTime() >= messageCreatedAt.getTime();
}

/**
 * Everyone who has demonstrably seen a message.
 *
 * The sender is always included without consulting a watermark. They wrote it;
 * requiring their own read receipt would leave every message they send looking
 * unread to themselves until they happened to mark the thread.
 */
export function resolveSeenBy(
  senderId: string,
  members: { userId: string; lastReadAt: Date | null }[],
  messageCreatedAt: Date,
): string[] {
  const seen = new Set<string>([senderId]);

  for (const member of members) {
    if (hasSeenMessage(member.lastReadAt, messageCreatedAt)) {
      seen.add(member.userId);
    }
  }

  return [...seen];
}

/* ── Direct-conversation shape ───────────────────────────────────────────── */

/**
 * The one place "a direct conversation has exactly two members" is stated.
 *
 * Isolating it is what keeps the rest of the module group-ready. Repository
 * queries, the read watermark, unread counting, reactions, and delivery all
 * operate on a member *set* of arbitrary size; only conversation creation
 * consults this. Implementing group chat means adding a second creation path,
 * not unpicking an assumption spread across the module (PRD §13: *"architecture
 * must support future group conversations"*).
 */
export const DIRECT_CONVERSATION_MEMBER_COUNT = 2;

export function isDirectConversationShape(memberIds: readonly string[]): boolean {
  return new Set(memberIds).size === DIRECT_CONVERSATION_MEMBER_COUNT;
}

/**
 * Canonical ordering for a direct pair.
 *
 * The schema has no unique constraint spanning two `ConversationMember` rows,
 * so duplicate prevention cannot be delegated to an index the way
 * `@@unique([followerId, followingId])` handles duplicate follows. Sorting the
 * pair gives a deterministic key that is identical no matter who initiates,
 * which is what the advisory lock in the repository is taken on.
 */
export function directConversationKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}
