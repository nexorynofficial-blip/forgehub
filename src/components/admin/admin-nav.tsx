"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Flag, LayoutGrid, Users } from "lucide-react";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: routes.admin.root, label: "Overview", icon: LayoutGrid },
  { href: routes.admin.reports, label: "Reports", icon: Flag },
  { href: routes.admin.users, label: "Users", icon: Users },
  { href: routes.admin.analytics, label: "Analytics", icon: BarChart3 },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin"
      className="flex gap-1 overflow-x-auto pb-1 lg:w-56 lg:shrink-0 lg:flex-col lg:overflow-visible lg:pb-0"
    >
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              isActive
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
