"use client";

import { useQuery } from "@tanstack/react-query";
import { notFound } from "next/navigation";

import { queryKeys } from "@/lib/query-keys";
import { getConversationById } from "@/lib/services/messaging-service";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageThread } from "@/components/messages/message-thread";

/**
 * The conversation page's data layer.
 *
 * Client-side and not negotiable here: correspondence is authenticated-only,
 * so a server render — which has no access token — would 401 on every thread
 * and show every user a "not found" page.
 */
export function ConversationView({ conversationId }: { conversationId: string }) {
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.conversation(conversationId),
    queryFn: () => getConversationById(conversationId),
  });

  if (isPending) {
    return (
      <Card className="flex h-full flex-col gap-4 p-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="flex-1" />
      </Card>
    );
  }

  // A conversation you are not part of answers 404, exactly as one that does
  // not exist does — membership is not something a stranger gets to probe.
  if (isError || !data) notFound();

  return <MessageThread conversation={data} />;
}
