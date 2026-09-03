"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Menu, MessageSquare } from "lucide-react";

import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { getConversations } from "@/lib/services/messaging-service";
import { useUIStore } from "@/store/ui-store";
import { Button } from "@/components/ui/button";
import { GlobalSearch } from "@/components/app/global-search";
import { NotificationsPanel } from "@/components/app/notifications-panel";
import { UserMenu } from "@/components/app/user-menu";

export function AppTopbar() {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);

  /**
   * The unread dot reads the first page of real conversations.
   *
   * A page rather than a grand total: the backend has no "unread conversation
   * count" endpoint, and the dot only needs to know whether the number is
   * above zero. `SocketProvider` invalidates this key on every `message:new`
   * and `message:read`, so it stays current without polling.
   */
  const { data } = useQuery({
    queryKey: queryKeys.conversations,
    queryFn: () => getConversations(),
  });
  const unreadMessages =
    data?.items.reduce((sum, conversation) => sum + conversation.unreadCount, 0) ?? 0;

  return (
    <header className="glass sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 px-4 sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open menu"
        onClick={toggleSidebar}
      >
        <Menu />
      </Button>

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-1 sm:ml-0">
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label="Messages"
          asChild
        >
          <Link href={routes.messages}>
            <MessageSquare />
            {unreadMessages > 0 && (
              <span
                className="bg-danger border-surface absolute top-1.5 right-1.5 size-2.5 rounded-full border-2"
                aria-hidden="true"
              />
            )}
          </Link>
        </Button>

        <NotificationsPanel />

        <div className="ml-1">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
