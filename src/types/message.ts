import type { ID, ISODateString } from "./common";

/** PRD.md §4.7 Messaging */
export interface MessageAttachment {
  id: ID;
  url: string;
  type: "image" | "file" | "voice";
  name: string;
}

export interface Message {
  id: ID;
  conversationId: ID;
  senderId: ID;
  content: string;
  attachments: MessageAttachment[];
  seenByUserIds: ID[];
  createdAt: ISODateString;
}

export interface Conversation {
  id: ID;
  participantIds: ID[];
  isGroup: boolean;
  title: string | null;
  lastMessage: Message | null;
  unreadCount: number;
}
