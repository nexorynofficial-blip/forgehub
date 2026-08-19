"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import {
  LayoutDashboard,
  MessageSquare,
  Plus,
  Rss,
  Settings,
  ShieldCheck,
  User,
  Users,
  X,
} from "lucide-react";

import { isAdminRole } from "@/lib/rbac";
import { routes } from "@/lib/routes";
import { getCurrentUser } from "@/lib/services/user-service";
import { getRecentConversations } from "@/lib/services/dashboard-service";
import { useLockBodyScroll } from "@/hooks/use-lock-body-scroll";
import { useUIStore } from "@/store/ui-store";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NavItem } from "@/components/app/nav-item";

function Logo() {
  return (
    <Link
      href={routes.home}
      className="font-display focus-visible:ring-ring rounded-sm text-lg font-semibold tracking-tight focus-visible:ring-2 focus-visible:outline-none"
    >
      Forge<span className="gradient-text-brand">Hub</span>
    </Link>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });
  const { data: conversations } = useQuery({
    queryKey: ["recentConversations"],
    queryFn: getRecentConversations,
  });

  const unreadMessages = conversations?.reduce((sum, c) => sum + c.unreadCount, 0) ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2 pb-6">
        <Logo />
      </div>

      <Button asChild size="md" className="mb-6 w-full">
        <Link href={routes.newProject} onClick={onNavigate}>
          <Plus />
          New project
        </Link>
      </Button>

      <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
        <NavItem
          href={routes.dashboard}
          label="Dashboard"
          icon={LayoutDashboard}
          onNavigate={onNavigate}
        />
        <NavItem href={routes.feed} label="Feed" icon={Rss} onNavigate={onNavigate} />
        {user && (
          <NavItem
            href={routes.profile(user.username)}
            label="Profile"
            icon={User}
            onNavigate={onNavigate}
          />
        )}
        <NavItem
          href={routes.communities}
          label="Communities"
          icon={Users}
          onNavigate={onNavigate}
        />
        <NavItem
          href={routes.messages}
          label="Messages"
          icon={MessageSquare}
          badge={unreadMessages}
          onNavigate={onNavigate}
        />
        <NavItem
          href={routes.settings.account}
          label="Settings"
          icon={Settings}
          onNavigate={onNavigate}
        />
        {user && isAdminRole(user.role) && (
          <NavItem
            href={routes.admin.root}
            label="Admin"
            icon={ShieldCheck}
            onNavigate={onNavigate}
          />
        )}
      </nav>

      <Link
        href={user ? routes.profile(user.username) : "#"}
        onClick={onNavigate}
        className="hover:bg-muted focus-visible:ring-ring mt-4 flex items-center gap-3 rounded-md p-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {isLoading || !user ? (
          <>
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-1.5 h-3 w-16" />
            </div>
          </>
        ) : (
          <>
            <Avatar>
              <AvatarImage src={user.avatarUrl ?? undefined} alt="" />
              <AvatarFallback>{user.displayName.charAt(0)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.displayName}</p>
              <p className="text-muted-foreground truncate text-xs">{user.builderRank}</p>
            </div>
          </>
        )}
      </Link>
    </div>
  );
}

/** Persistent desktop sidebar (UI_UX.md §7 "Sidebar"). */
export function AppSidebar() {
  return (
    <aside className="border-border bg-surface sticky top-0 hidden h-screen shrink-0 flex-col border-r px-4 py-6 lg:flex lg:w-64">
      <LayoutGroup id="sidebar-desktop">
        <SidebarNav />
      </LayoutGroup>
    </aside>
  );
}

/** Slide-in sidebar for < lg viewports, driven by the shared UI store so the
 * topbar's menu button can open it. */
export function MobileSidebarDrawer() {
  const isOpen = useUIStore((state) => state.isSidebarOpen);
  const setOpen = useUIStore((state) => state.setSidebarOpen);
  useLockBodyScroll(isOpen);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-50 bg-black/60 lg:hidden"
            aria-hidden="true"
          />
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="bg-surface fixed inset-y-0 left-0 z-50 flex w-72 flex-col px-4 py-6 lg:hidden"
          >
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
            <LayoutGroup id="sidebar-mobile">
              <SidebarNav onNavigate={() => setOpen(false)} />
            </LayoutGroup>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
