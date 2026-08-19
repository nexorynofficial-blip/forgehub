"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { getConversationLabel } from "@/lib/messaging";
import { getConversations, getOnlineUserIds } from "@/lib/services/messaging-service";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationListItem } from "@/components/messages/conversation-list-item";

/** PRD.md §4.7 "Message Search" is scoped here to filtering conversations
 * by name, not full-text search across every message body — see
 * docs/ASSUMPTIONS.md (Phase 09). */
export function ConversationList() {
  const { data: conversations, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: getConversations,
  });
  const { data: onlineIds } = useQuery({
    queryKey: ["onlineUserIds"],
    queryFn: getOnlineUserIds,
  });
  const [search, setSearch] = useState("");

  const filtered = (conversations ?? []).filter((conversation) => {
    const query = search.trim().toLowerCase();
    return !query || getConversationLabel(conversation).toLowerCase().includes(query);
  });

  return (
    <Card className="flex h-full flex-col gap-3 p-3">
      <div className="relative shrink-0">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          className="pl-10"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading || !conversations ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5">
                <Skeleton className="size-10 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground p-4 text-center text-sm">
            No conversations found.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((conversation) => (
              <ConversationListItem
                key={conversation.id}
                conversation={conversation}
                isOnline={conversation.participants.some((person) =>
                  onlineIds?.has(person.id),
                )}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
