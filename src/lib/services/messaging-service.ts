import type {
  ConversationWithParticipants,
  MessageAttachment,
  MessageWithSender,
  PostAuthor,
} from "@/types";
import { mockConversations } from "@/lib/mock/conversations";
import { mockMessagesByConversationId } from "@/lib/mock/messages";
import { mockOnlineUserIds } from "@/lib/mock/online-status";
import { resolvePersonById } from "@/lib/mock/people";
import { mockCurrentUser } from "@/lib/mock/users";

/** Placeholder for the Messaging API (TRD.md §5) and its Socket.IO
 * real-time layer (TRD.md §6) — see docs/ASSUMPTIONS.md (Phase 09) for how
 * "real-time" is simulated here without a socket connection. */

function withParticipants(
  conversation: (typeof mockConversations)[number],
): ConversationWithParticipants {
  const participants = conversation.participantIds
    .filter((id) => id !== mockCurrentUser.id)
    .map((id) => resolvePersonById(id))
    .filter((person): person is PostAuthor => person !== null);
  return { ...conversation, participants };
}

export async function getConversations(): Promise<ConversationWithParticipants[]> {
  const lastActivity = (conversation: ConversationWithParticipants) =>
    conversation.lastMessage ? new Date(conversation.lastMessage.createdAt).getTime() : 0;

  return mockConversations
    .map(withParticipants)
    .sort((a, b) => lastActivity(b) - lastActivity(a));
}

export async function getConversationById(
  id: string,
): Promise<ConversationWithParticipants | null> {
  const conversation = mockConversations.find((c) => c.id === id);
  return conversation ? withParticipants(conversation) : null;
}

export async function getMessages(conversationId: string): Promise<MessageWithSender[]> {
  return (mockMessagesByConversationId[conversationId] ?? [])
    .map((message) => {
      const sender = resolvePersonById(message.senderId);
      return sender ? { ...message, sender } : null;
    })
    .filter((message): message is MessageWithSender => message !== null);
}

export async function sendMessage(
  conversationId: string,
  content: string,
  sender: PostAuthor,
  attachments: MessageAttachment[] = [],
): Promise<MessageWithSender> {
  const message: MessageWithSender = {
    id: crypto.randomUUID(),
    conversationId,
    senderId: sender.id,
    content,
    attachments,
    seenByUserIds: [sender.id],
    createdAt: new Date().toISOString(),
    sender,
  };
  mockMessagesByConversationId[conversationId] = [
    ...(mockMessagesByConversationId[conversationId] ?? []),
    message,
  ];

  const conversation = mockConversations.find((c) => c.id === conversationId);
  if (conversation) conversation.lastMessage = message;

  return message;
}

export async function getOnlineUserIds(): Promise<Set<string>> {
  return mockOnlineUserIds;
}

let typingPollCount = 0;

/** Simulates the other participant typing on a poll interval — a real
 * implementation would receive this over the Phase 09 Socket.IO connection
 * (TRD.md §6), not poll. Returns the typer once every few polls so
 * `TypingIndicator` has something to demonstrate. */
export async function checkTypingIndicator(
  conversation: ConversationWithParticipants,
): Promise<PostAuthor | null> {
  typingPollCount += 1;
  if (typingPollCount % 4 !== 0) return null;
  return conversation.participants[0] ?? null;
}
