"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { LayoutDashboard, MessageSquare, Plus, Rss, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: routes.dashboard, label: "Dashboard", icon: LayoutDashboard },
  { href: routes.feed, label: "Feed", icon: Rss },
  { href: routes.communities, label: "Communities", icon: Users },
  { href: routes.messages, label: "Messages", icon: MessageSquare },
];

/** UI_UX.md §11 Mobile UX: bottom navigation + floating action button. Shown
 * below `lg`, where AppSidebar is hidden. */
export function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="glass fixed inset-x-0 bottom-0 z-30 flex h-16 items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {NAV_ITEMS.slice(0, 2).map((item) => (
        <BottomNavLink key={item.href} item={item} pathname={pathname} />
      ))}

      <Link href={routes.newProject} aria-label="New project" className="relative -top-5">
        <motion.span
          whileTap={{ scale: 0.9 }}
          className="bg-primary text-primary-foreground flex size-14 items-center justify-center rounded-full shadow-[var(--shadow-glow-primary)]"
        >
          <Plus className="size-6" />
        </motion.span>
      </Link>

      {NAV_ITEMS.slice(2).map((item) => (
        <BottomNavLink key={item.href} item={item} pathname={pathname} />
      ))}
    </nav>
  );
}

function BottomNavLink({
  item,
  pathname,
}: {
  item: { href: string; label: string; icon: LucideIcon };
  pathname: string;
}) {
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ring relative flex flex-1 flex-col items-center gap-1 rounded-md py-1.5 text-[11px] font-medium focus-visible:ring-2 focus-visible:outline-none",
        isActive ? "text-primary" : "text-muted-foreground",
      )}
    >
      {isActive && (
        <motion.span
          layoutId="bottom-nav-active-pill"
          className="bg-primary/15 absolute inset-x-1 inset-y-0.5 rounded-md"
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
        />
      )}
      <Icon className="relative size-5" />
      <span className="relative">{item.label}</span>
    </Link>
  );
}
