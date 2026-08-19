"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { formatRelativeTime } from "@/lib/format";
import { getConversationLabel } from "@/lib/messaging";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { ConversationWithParticipants } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export function ConversationListItem({
  conversation,
  isOnline,
}: {
  conversation: ConversationWithParticipants;
  isOnline: boolean;
}) {
  const pathname = usePathname();
  const href = routes.conversation(conversation.id);
  const isActive = pathname === href;
  const label = getConversationLabel(conversation);

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-md p-2.5 transition-colors",
        isActive ? "bg-primary/15" : "hover:bg-muted",
      )}
    >
      <div className="relative shrink-0">
        <Avatar>
          <AvatarImage
            src={conversation.participants[0]?.avatarUrl ?? undefined}
            alt=""
          />
          <AvatarFallback>{label.charAt(0)}</AvatarFallback>
        </Avatar>
        {!conversation.isGroup && isOnline && (
          <span
            className="bg-success border-card absolute right-0 bottom-0 size-2.5 rounded-full border-2"
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p
            className={cn(
              "truncate text-sm",
              conversation.unreadCount > 0 ? "font-semibold" : "font-medium",
            )}
          >
            {label}
          </p>
          {conversation.lastMessage && (
            <time className="text-muted-foreground shrink-0 text-xs">
              {formatRelativeTime(conversation.lastMessage.createdAt)}
            </time>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {conversation.lastMessage?.content}
        </p>
      </div>
      {conversation.unreadCount > 0 && (
        <Badge variant="primary">{conversation.unreadCount}</Badge>
      )}
    </Link>
  );
}
