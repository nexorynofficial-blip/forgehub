"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { getConversationLabel } from "@/lib/messaging";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import {
  getMessages,
  markConversationRead,
  sendMessage,
  type Conversation,
} from "@/lib/services/messaging-service";
import { getCurrentUser } from "@/lib/services/user-service";
import { useSocket } from "@/providers/socket-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "@/components/messages/message-bubble";
import { MessageComposer } from "@/components/messages/message-composer";
import { TypingIndicator } from "@/components/messages/typing-indicator";

/**
 * UI_UX.md's "Discord-style" thread — same layout, real data underneath.
 *
 * Two structural facts drive the code below:
 *
 *  - History is **cursor-paginated newest-first**, so the fetched order is the
 *    reverse of the display order and the list is reversed once for rendering.
 *  - New messages arrive over the socket, not from a refetch. `SocketProvider`
 *    writes them into this exact query key, so nothing here polls.
 */
export function MessageThread({ conversation }: { conversation: Conversation }) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const {
    onlineUserIds,
    typingByConversation,
    joinConversation,
    leaveConversation,
    emitTyping,
    isConnected,
  } = useSocket();

  const { data: currentUser } = useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: getCurrentUser,
  });

  const { data, isLoading } = useInfiniteQuery({
    queryKey: queryKeys.messages(conversation.id),
    queryFn: ({ pageParam }) =>
      getMessages(conversation.id, { cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  /**
   * Join the conversation room, and leave it on the way out.
   *
   * The room is what scopes typing indicators; without joining, this thread
   * would receive `message:new` (addressed to the user room) but never see
   * anyone typing. The join is authorized server-side against membership, so a
   * request for someone else's conversation is refused rather than trusted.
   */
  useEffect(() => {
    if (!isConnected) return;
    joinConversation(conversation.id);
    return () => leaveConversation(conversation.id);
  }, [isConnected, conversation.id, joinConversation, leaveConversation]);

  /** Opening a thread is what marks it read; the server owns the watermark. */
  useEffect(() => {
    void markConversationRead(conversation.id)
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.conversations }))
      .catch(() => undefined);
  }, [conversation.id, queryClient]);

  // Fetched newest-first, rendered oldest-first.
  const messages = (data?.pages.flatMap((page) => page.items) ?? []).slice().reverse();
  const typingUsernames = typingByConversation[conversation.id] ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, typingUsernames.length]);

  /**
   * Sent over REST rather than the socket.
   *
   * Both paths persist and both fan out `message:new`, but REST reports a
   * refusal — a block, a contact policy — as a status code the UI can render.
   * The server's own `message:new` echo is what lands the message in the list,
   * and `SocketProvider` de-duplicates by id.
   */
  async function handleSend(content: string) {
    await sendMessage(conversation.id, content);
    void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
  }

  const isOnline = conversation.participants.some((person) =>
    onlineUserIds.has(person.id),
  );
  const label = getConversationLabel(conversation);

  return (
    <Card className="flex h-full flex-col overflow-hidden p-0">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" asChild className="lg:hidden">
          <Link href={routes.messages} aria-label="Back to conversations">
            <ArrowLeft />
          </Link>
        </Button>
        <Avatar className="size-9">
          <AvatarImage
            src={conversation.participants[0]?.avatarUrl ?? undefined}
            alt=""
          />
          <AvatarFallback>{label.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{label}</h1>
          {!conversation.isGroup && (
            <p className="text-muted-foreground text-xs">
              {isOnline ? "Online" : "Offline"}
            </p>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-2/3" />
            ))}
          </div>
        ) : messages.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No messages yet — say hello.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const showSender =
                conversation.isGroup &&
                (!previous || previous.senderId !== message.senderId);
              const isOwn = currentUser ? message.senderId === currentUser.id : false;
              const showStatus = isOwn && index === messages.length - 1;
              const isSeen =
                showStatus &&
                conversation.participants.some((person) =>
                  message.seenByUserIds.includes(person.id),
                );
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isOwn={isOwn}
                  showSender={showSender}
                  showStatus={showStatus}
                  isSeen={isSeen}
                />
              );
            })}
            <TypingIndicator usernames={typingUsernames} />
          </div>
        )}
      </div>

      <MessageComposer
        onSend={handleSend}
        onTyping={(typing) => emitTyping(conversation.id, typing)}
      />
    </Card>
  );
}
