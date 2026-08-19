"use client";

import { useQuery } from "@tanstack/react-query";
import { Flag, FolderGit2, Users2, UsersRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { getOverviewStats } from "@/lib/services/admin-service";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OverviewStats() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["adminOverviewStats"],
    queryFn: getOverviewStats,
  });

  const items: { label: string; value: string; icon: LucideIcon }[] | null = stats
    ? [
        {
          label: "Total users",
          value: formatCompactNumber(stats.totalUsers),
          icon: UsersRound,
        },
        {
          label: "Total projects",
          value: formatCompactNumber(stats.totalProjects),
          icon: FolderGit2,
        },
        {
          label: "Total communities",
          value: formatCompactNumber(stats.totalCommunities),
          icon: Users2,
        },
        {
          label: "Pending reports",
          value: String(stats.pendingReportsCount),
          icon: Flag,
        },
      ]
    : null;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {isLoading || !items
        ? Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-5">
              <Skeleton className="size-9 rounded-full" />
              <Skeleton className="mt-4 h-7 w-16" />
              <Skeleton className="mt-2 h-4 w-24" />
            </Card>
          ))
        : items.map((item) => (
            <Card key={item.label} className="p-5">
              <span className="bg-primary/15 text-primary flex size-9 items-center justify-center rounded-full">
                <item.icon className="size-4" />
              </span>
              <p className="font-display mt-4 text-2xl font-semibold tracking-tight">
                {item.value}
              </p>
              <p className="text-muted-foreground text-sm">{item.label}</p>
            </Card>
          ))}
    </div>
  );
}
