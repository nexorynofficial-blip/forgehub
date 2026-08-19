"use client";

import { usePathname } from "next/navigation";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ConversationList } from "@/components/messages/conversation-list";

/**
 * Responsive Discord-style two-pane shell. Below `lg`, only one pane shows
 * at a time — the conversation list at `/messages`, the active thread at
 * `/messages/[conversationId]` (with its own back button) — decided here
 * via `usePathname()` since a shared layout has no other way to know which
 * leaf route matched. See docs/ASSUMPTIONS.md (Phase 09).
 */
export function MessagesShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isConversationActive = pathname !== routes.messages;

  return (
    <div className="flex h-[70vh] gap-4 pt-8 lg:h-[75vh]">
      <div
        className={cn(
          "w-full shrink-0 lg:w-80",
          isConversationActive && "hidden lg:block",
        )}
      >
        <ConversationList />
      </div>
      <div className={cn("min-w-0 flex-1", !isConversationActive && "hidden lg:block")}>
        {children}
      </div>
    </div>
  );
}
