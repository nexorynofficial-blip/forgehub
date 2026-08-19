"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { getConversationLabel } from "@/lib/messaging";
import { routes } from "@/lib/routes";
import {
  checkTypingIndicator,
  getMessages,
  getOnlineUserIds,
  sendMessage,
} from "@/lib/services/messaging-service";
import { getCurrentUser } from "@/lib/services/user-service";
import type {
  ConversationWithParticipants,
  MessageAttachment,
  MessageWithSender,
  PostAuthor,
} from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "@/components/messages/message-bubble";
import { MessageComposer } from "@/components/messages/message-composer";
import { TypingIndicator } from "@/components/messages/typing-indicator";

/** UI_UX.md's "Discord-style" brief — Card fills its column of
 * `MessagesShell`'s fixed-height layout; header, scrollable messages, and
 * composer split via flex so only the message list scrolls. */
export function MessageThread({
  conversation,
}: {
  conversation: ConversationWithParticipants;
}) {
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });
  const { data: messages, isLoading } = useQuery({
    queryKey: ["messages", conversation.id],
    queryFn: () => getMessages(conversation.id),
  });
  const { data: onlineIds } = useQuery({
    queryKey: ["onlineUserIds"],
    queryFn: getOnlineUserIds,
  });
  const { data: typingPerson } = useQuery({
    queryKey: ["typingIndicator", conversation.id],
    queryFn: () => checkTypingIndicator(conversation),
    refetchInterval: 5_000,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages?.length, typingPerson]);

  async function handleSend(content: string, attachments: MessageAttachment[]) {
    if (!currentUser) return;
    const author: PostAuthor = {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      avatarUrl: currentUser.avatarUrl,
      builderRank: currentUser.builderRank,
    };
    const message = await sendMessage(conversation.id, content, author, attachments);
    queryClient.setQueryData<MessageWithSender[]>(
      ["messages", conversation.id],
      (prev) => [...(prev ?? []), message],
    );
    queryClient.invalidateQueries({ queryKey: ["conversations"] });
  }

  const isOnline = conversation.participants.some((person) => onlineIds?.has(person.id));
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
        {isLoading || !messages ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-2/3" />
            ))}
          </div>
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
            {typingPerson && <TypingIndicator person={typingPerson} />}
          </div>
        )}
      </div>

      <MessageComposer onSend={handleSend} />
    </Card>
  );
}
