"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Lock, Palette, User } from "lucide-react";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: routes.settings.account, label: "Account", icon: User },
  { href: routes.settings.appearance, label: "Appearance", icon: Palette },
  { href: routes.settings.privacy, label: "Privacy", icon: Lock },
  { href: routes.settings.notifications, label: "Notifications", icon: Bell },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Settings"
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
