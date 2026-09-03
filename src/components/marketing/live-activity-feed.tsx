"use client";

import { useQuery } from "@tanstack/react-query";
import { Rocket, Target, UserPlus, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { getRecentActivity } from "@/lib/services/marketing-service";
import { cn } from "@/lib/utils";
import type { ActivityItem, ActivityKind } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  launch: Rocket,
  milestone: Target,
  collaboration: Users,
  follow: UserPlus,
};

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = KIND_ICON[item.kind];
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="bg-primary/15 text-primary flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" />
      </span>
      <p className="text-sm leading-relaxed">
        <span className="text-foreground font-medium">{item.actorName}</span>{" "}
        <span className="text-muted-foreground">{item.message}</span>
      </p>
      <time className="text-muted-foreground ml-auto shrink-0 text-xs whitespace-nowrap">
        {formatRelativeTime(item.occurredAt)}
      </time>
    </li>
  );
}

/**
 * UI_UX.md §6 "Live Activity Feed", also reused as the dashboard's activity
 * widget via `ActivityFeedWidget`.
 *
 * **No backend endpoint exists** for a public or personal activity stream, so
 * the service returns nothing and this renders an unavailable state. The
 * pulsing "Live" indicator is hidden while there is nothing live to show —
 * leaving it animating above an empty card would be the most literal possible
 * claim of realtime data that is not there.
 */
export function LiveActivityFeed({ className }: { className?: string }) {
  const { data: activity, isLoading } = useQuery({
    queryKey: ["recentActivity"],
    queryFn: getRecentActivity,
  });

  const hasActivity = (activity?.length ?? 0) > 0;

  return (
    <Card className={cn("glass w-full max-w-md", className)}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Live activity</CardTitle>
        {hasActivity && (
          <span className="text-success flex items-center gap-1.5 text-xs font-medium">
            <span className="bg-success relative flex size-2">
              <span className="bg-success absolute inline-flex size-full animate-ping rounded-full opacity-75" />
              <span className="bg-success relative inline-flex size-2 rounded-full" />
            </span>
            Live
          </span>
        )}
      </CardHeader>
      <CardContent>
        {isLoading || !activity ? (
          <ul className="divide-border divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 py-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))}
          </ul>
        ) : !hasActivity ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            Activity feeds are not available yet.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {activity.map((item) => (
              <ActivityRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
