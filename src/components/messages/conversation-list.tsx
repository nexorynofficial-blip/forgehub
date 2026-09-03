"use client";

import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";

import { getConversationLabel } from "@/lib/messaging";
import { queryKeys } from "@/lib/query-keys";
import { getConversations } from "@/lib/services/messaging-service";
import { useSocket } from "@/providers/socket-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConversationListItem } from "@/components/messages/conversation-list-item";

/**
 * PRD.md §4.7 conversation list.
 *
 * The search still filters loaded conversations by name — the backend has no
 * conversation-list search parameter and inventing one is not this phase's
 * job. What changed: ordering now comes from the server (most recent activity
 * first) rather than a local sort, and presence comes from the socket rather
 * than a polled fixture.
 */
export function ConversationList() {
  const [search, setSearch] = useState("");
  const { onlineUserIds } = useSocket();

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: queryKeys.conversations,
      queryFn: ({ pageParam }) => getConversations({ cursor: pageParam ?? undefined }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const conversations = data?.pages.flatMap((page) => page.items) ?? [];
  const query = search.trim().toLowerCase();
  const filtered = query
    ? conversations.filter((conversation) =>
        getConversationLabel(conversation).toLowerCase().includes(query),
      )
    : conversations;

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
        {isLoading ? (
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
            {conversations.length === 0
              ? "No conversations yet."
              : "No conversations found."}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {filtered.map((conversation) => (
              <ConversationListItem
                key={conversation.id}
                conversation={conversation}
                isOnline={conversation.participants.some((person) =>
                  onlineUserIds.has(person.id),
                )}
              />
            ))}
            {hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
                Load older
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
