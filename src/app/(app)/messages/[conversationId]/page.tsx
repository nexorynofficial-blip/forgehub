import type { Metadata } from "next";

import { ConversationView } from "@/components/messages/conversation-view";

interface ConversationPageProps {
  params: Promise<{ conversationId: string }>;
}

/**
 * A static title. Resolving the participant's name would need an
 * authenticated request, and there is no token on the server — every
 * conversation would 401 and the title would read "Conversation not found"
 * for threads the user is perfectly entitled to read.
 */
export const metadata: Metadata = { title: "Messages" };

export default async function ConversationPage({ params }: ConversationPageProps) {
  const { conversationId } = await params;
  return <ConversationView conversationId={conversationId} />;
}
