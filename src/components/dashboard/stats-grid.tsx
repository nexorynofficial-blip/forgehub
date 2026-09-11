"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Flame, FolderGit2, Users, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { getCurrentUser } from "@/lib/services/user-service";
import { cn } from "@/lib/utils";
import type { User } from "@/types";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The four numbers that describe an account, with the layout doing the
 * ranking.
 *
 * Previously these were four identical cards — a small icon chip over a number
 * over a label, four times — equal weight for unequal facts, which is much of
 * why the dashboard read as a wireframe. Now XP leads: it is the number the
 * whole reputation model is built on, and it carries the builder rank, which
 * is the word that number earns you. The other three support it.
 *
 * No trend arrows and no "+12% this week". The backend serves current counters
 * only — there is no history endpoint behind any of these — and a fabricated
 * delta on someone's own dashboard is a lie about their own account.
 */

interface Stat {
  label: string;
  value: string;
  icon: LucideIcon;
}

function supportingStats(user: User): Stat[] {
  return [
    { label: "Followers", value: formatCompactNumber(user.followersCount), icon: Users },
    {
      label: "Projects",
      value: formatCompactNumber(user.projectsCount),
      icon: FolderGit2,
    },
    { label: "Day streak", value: `${user.dailyStreak}`, icon: Flame },
  ];
}

/** The shared shell: a raised surface with the icon as a watermark rather than
 * a chip, so the number is the only thing competing for attention. */
function StatTile({
  children,
  icon: Icon,
  className,
  accent,
}: {
  children: React.ReactNode;
  icon: LucideIcon;
  className?: string;
  accent?: boolean;
}) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      className={cn(
        "raised relative isolate overflow-hidden rounded-lg p-5",
        accent && "rim-primary",
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -right-3 -bottom-3 -z-10 size-24 opacity-[0.07]",
          accent ? "text-primary" : "text-foreground",
        )}
      />
      {children}
    </motion.div>
  );
}

export function StatsGrid() {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  if (isLoading || !user) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Skeleton className="h-[7.5rem] rounded-lg lg:col-span-2" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[7.5rem] rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatTile icon={Zap} accent className="lg:col-span-2">
        <p className="text-primary text-xs font-medium tracking-[0.14em] uppercase">
          Reputation
        </p>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-display text-4xl font-semibold tracking-tight tabular-nums">
            {formatCompactNumber(user.xp)}
          </span>
          <span className="text-muted-foreground text-sm">XP</span>
        </div>
        <p className="text-surface-foreground mt-1 text-sm">{user.builderRank}</p>
      </StatTile>

      {supportingStats(user).map((stat) => (
        <StatTile key={stat.label} icon={stat.icon}>
          <p className="text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase">
            {stat.label}
          </p>
          <p className="font-display mt-3 text-3xl font-semibold tracking-tight tabular-nums">
            {stat.value}
          </p>
        </StatTile>
      ))}
    </div>
  );
}
