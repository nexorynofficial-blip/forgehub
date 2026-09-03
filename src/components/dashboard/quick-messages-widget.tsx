"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { formatRelativeTime } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getRecentConversations } from "@/lib/services/dashboard-service";
import { useSocket } from "@/providers/socket-provider";
import type { RecentConversationPreview } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ConversationRow({
  conversation,
  isOnline,
}: {
  conversation: RecentConversationPreview;
  isOnline: boolean;
}) {
  return (
    <Link
      href={routes.conversation(conversation.id)}
      className="hover:bg-muted focus-visible:ring-ring flex items-center gap-3 rounded-md p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <div className="relative shrink-0">
        <Avatar>
          <AvatarImage src={conversation.participantAvatarUrl ?? undefined} alt="" />
          <AvatarFallback>{conversation.participantName.charAt(0)}</AvatarFallback>
        </Avatar>
        {isOnline && (
          <span
            className="bg-success border-card absolute right-0 bottom-0 size-2.5 rounded-full border-2"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{conversation.participantName}</p>
          <time className="text-muted-foreground shrink-0 text-xs">
            {formatRelativeTime(conversation.lastMessageAt)}
          </time>
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {conversation.lastMessage}
        </p>
      </div>
      {conversation.unreadCount > 0 && (
        <Badge variant="primary">{conversation.unreadCount}</Badge>
      )}
    </Link>
  );
}

/**
 * UI_UX.md §7 "Chat" — a preview of the real conversation list.
 *
 * Presence is overlaid from the socket rather than read off the row: the
 * service cannot subscribe to realtime events, so it reports `isOnline: false`
 * and this component supplies the live answer.
 */
export function QuickMessagesWidget() {
  const { onlineUserIds } = useSocket();
  const { data: conversations, isLoading } = useQuery({
    queryKey: ["recentConversations"],
    queryFn: () => getRecentConversations(),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Messages</CardTitle>
        <Link
          href={routes.messages}
          className="text-primary focus-visible:ring-ring rounded-sm text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {isLoading || !conversations ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-2">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))
        ) : conversations.length === 0 ? (
          <p className="text-muted-foreground p-2 text-sm">No conversations yet.</p>
        ) : (
          conversations.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              isOnline={
                conversation.participantId !== null &&
                onlineUserIds.has(conversation.participantId)
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
