"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Flame, FolderGit2, Users, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { getCurrentUser } from "@/lib/services/user-service";
import { cn } from "@/lib/utils";
import type { User } from "@/types";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Stat {
  label: string;
  value: string;
  icon: LucideIcon;
}

function buildStats(user: User): Stat[] {
  return [
    { label: "Followers", value: formatCompactNumber(user.followersCount), icon: Users },
    {
      label: "Projects",
      value: formatCompactNumber(user.projectsCount),
      icon: FolderGit2,
    },
    { label: "XP", value: formatCompactNumber(user.xp), icon: Zap },
    { label: "Daily streak", value: `${user.dailyStreak}d`, icon: Flame },
  ];
}

export function StatsGrid() {
  const { data: user, isLoading } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {isLoading || !user
        ? Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="size-9 rounded-full" />
              <Skeleton className="mt-4 h-7 w-16" />
              <Skeleton className="mt-2 h-4 w-20" />
            </Card>
          ))
        : buildStats(user).map((stat) => {
            const isStreak = stat.icon === Flame;
            return (
              <motion.div
                key={stat.label}
                whileHover={{ y: -3 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
              >
                <Card className="hover:border-border-strong p-5 transition-colors">
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-full",
                      isStreak
                        ? "bg-accent/15 text-accent"
                        : "bg-primary/15 text-primary",
                    )}
                  >
                    {isStreak ? (
                      <motion.span
                        animate={{
                          scale: [1, 1.12, 0.96, 1.06, 1],
                          rotate: [0, -4, 3, -2, 0],
                        }}
                        transition={{
                          duration: 2.2,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                        className="inline-flex"
                      >
                        <stat.icon className="size-5" />
                      </motion.span>
                    ) : (
                      <stat.icon className="size-5" />
                    )}
                  </span>
                  <p className="font-display mt-4 text-2xl font-semibold tracking-tight">
                    {stat.value}
                  </p>
                  <p className="text-muted-foreground text-sm">{stat.label}</p>
                </Card>
              </motion.div>
            );
          })}
    </div>
  );
}
