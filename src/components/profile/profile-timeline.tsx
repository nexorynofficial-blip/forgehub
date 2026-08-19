"use client";

import { useQuery } from "@tanstack/react-query";
import { Rocket, Target, UserPlus, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { getProfileTimeline } from "@/lib/services/profile-service";
import type { ActivityItem, ActivityKind } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  launch: Rocket,
  milestone: Target,
  collaboration: Users,
  follow: UserPlus,
};

function TimelineRow({ item, isLast }: { item: ActivityItem; isLast: boolean }) {
  const Icon = KIND_ICON[item.kind];

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast && (
        <span
          className="bg-border absolute top-8 bottom-0 left-4 w-px"
          aria-hidden="true"
        />
      )}
      <span className="bg-primary/15 text-primary relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-foreground text-sm leading-relaxed">{item.message}</p>
        <time className="text-muted-foreground text-xs">
          {formatRelativeTime(item.occurredAt)}
        </time>
      </div>
    </li>
  );
}

/** UI_UX.md §8 "Timeline" — reuses `ActivityItem`, scoped to one profile.
 * See docs/ASSUMPTIONS.md (Phase 05). */
export function ProfileTimeline({ username }: { username: string }) {
  const { data: timeline, isLoading } = useQuery({
    queryKey: ["profileTimeline", username],
    queryFn: () => getProfileTimeline(username),
  });

  if (!isLoading && timeline?.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !timeline ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ) : (
          <ul>
            {timeline.map((item, index) => (
              <TimelineRow
                key={item.id}
                item={item}
                isLast={index === timeline.length - 1}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
