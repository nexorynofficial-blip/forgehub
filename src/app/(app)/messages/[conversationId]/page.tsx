import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getConversationLabel } from "@/lib/messaging";
import { getConversationById } from "@/lib/services/messaging-service";
import { MessageThread } from "@/components/messages/message-thread";

interface ConversationPageProps {
  params: Promise<{ conversationId: string }>;
}

export async function generateMetadata({
  params,
}: ConversationPageProps): Promise<Metadata> {
  const { conversationId } = await params;
  const conversation = await getConversationById(conversationId);
  if (!conversation) return { title: "Conversation not found" };
  return { title: getConversationLabel(conversation) };
}

export default async function ConversationPage({ params }: ConversationPageProps) {
  const { conversationId } = await params;
  const conversation = await getConversationById(conversationId);
  if (!conversation) notFound();

  return <MessageThread conversation={conversation} />;
}
