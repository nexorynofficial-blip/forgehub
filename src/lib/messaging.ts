import type { ConversationWithParticipants } from "@/types";

/** Shared by `MessageThread` and `ConversationListItem` so a group's
 * fallback label (no `title` set) can't drift between the two views. */
export function getConversationLabel(conversation: ConversationWithParticipants): string {
  if (conversation.title) return conversation.title;
  return (
    conversation.participants.map((person) => person.displayName).join(", ") ||
    "Conversation"
  );
}
