"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface NavItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  onNavigate?: () => void;
}

export function NavItem({ href, label, icon: Icon, badge, onNavigate }: NavItemProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
        isActive
          ? "text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {isActive && (
        <motion.span
          layoutId="nav-active-pill"
          className="bg-primary/15 absolute inset-0 rounded-md"
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
        />
      )}
      <Icon className="relative size-5 shrink-0" />
      <span className="relative flex-1">{label}</span>
      {!!badge && (
        <Badge variant="primary" className="relative shrink-0">
          {badge}
        </Badge>
      )}
    </Link>
  );
}
