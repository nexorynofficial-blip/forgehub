import { File, Image as ImageIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MessageWithSender } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function MessageBubble({
  message,
  isOwn,
  showSender,
  showStatus,
  isSeen,
}: {
  message: MessageWithSender;
  isOwn: boolean;
  showSender: boolean;
  /** Only the last message in the thread shows a Seen/Delivered status. */
  showStatus: boolean;
  isSeen: boolean;
}) {
  return (
    <div className={cn("flex items-end gap-2", isOwn && "flex-row-reverse")}>
      <div className="w-8 shrink-0">
        {showSender && !isOwn && (
          <Avatar className="size-8">
            <AvatarImage src={message.sender.avatarUrl ?? undefined} alt="" />
            <AvatarFallback className="text-xs">
              {message.sender.displayName.charAt(0)}
            </AvatarFallback>
          </Avatar>
        )}
      </div>
      <div
        className={cn(
          "flex max-w-[75%] flex-col gap-1",
          isOwn ? "items-end" : "items-start",
        )}
      >
        {showSender && !isOwn && (
          <span className="text-muted-foreground px-1 text-xs">
            {message.sender.displayName}
          </span>
        )}
        <div
          className={cn(
            "rounded-2xl px-4 py-2.5 text-sm",
            isOwn
              ? "bg-primary text-primary-foreground rounded-br-sm"
              : "bg-surface rounded-bl-sm",
          )}
        >
          {message.attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={cn(
                "mb-1.5 flex items-center gap-2 rounded-lg px-2.5 py-2",
                isOwn ? "bg-white/10" : "bg-muted",
              )}
            >
              {attachment.type === "image" ? (
                <ImageIcon className="size-4 shrink-0" />
              ) : (
                <File className="size-4 shrink-0" />
              )}
              <span className="truncate text-xs">{attachment.name}</span>
            </div>
          ))}
          {message.content && <p className="leading-relaxed">{message.content}</p>}
        </div>
        <div className="text-muted-foreground flex items-center gap-1 px-1 text-[11px]">
          <time>{formatRelativeTime(message.createdAt)}</time>
          {isOwn && showStatus && <span>· {isSeen ? "Seen" : "Delivered"}</span>}
        </div>
      </div>
    </div>
  );
}
