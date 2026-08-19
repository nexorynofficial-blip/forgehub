import type { Conversation, Message } from "./message";
import type { PostAuthor } from "./feed";

/**
 * Presentation-layer types for Messaging (Phase 09), same joined-view
 * convention as `PostWithAuthor` — `Conversation`/`Message` only store
 * userIds, a UI needs names/avatars to render.
 */
export interface ConversationWithParticipants extends Conversation {
  /** Every participant except the signed-in user. */
  participants: PostAuthor[];
}

export interface MessageWithSender extends Message {
  sender: PostAuthor;
}
