"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Menu, MessageSquare, Search } from "lucide-react";

import { routes } from "@/lib/routes";
import { getRecentConversations } from "@/lib/services/dashboard-service";
import { useUIStore } from "@/store/ui-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NotificationsPanel } from "@/components/app/notifications-panel";
import { UserMenu } from "@/components/app/user-menu";

export function AppTopbar() {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const { data: conversations } = useQuery({
    queryKey: ["recentConversations"],
    queryFn: getRecentConversations,
  });
  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unreadCount, 0) ?? 0;

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

      <div className="relative hidden max-w-sm flex-1 sm:block">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          placeholder="Search projects, people, communities…"
          aria-label="Search"
          className="pl-10"
        />
      </div>

      <div className="ml-auto flex items-center gap-1 sm:ml-0">
        <Button
          variant="ghost"
          size="icon"
          className="relative sm:hidden"
          aria-label="Search"
        >
          <Search />
        </Button>

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
