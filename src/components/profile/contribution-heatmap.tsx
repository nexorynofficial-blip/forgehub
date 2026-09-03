"use client";

import { useQuery } from "@tanstack/react-query";

import { getContributionGraph } from "@/lib/services/profile-service";
import { cn } from "@/lib/utils";
import type { ContributionDay } from "@/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/25",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
];

function chunkIntoWeeks(days: ContributionDay[]): ContributionDay[][] {
  const weeks: ContributionDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  return weeks;
}

/** UI_UX.md §8 "Contribution Heatmap" — GitHub-style, one cell per day over
 * the last year. */
export function ContributionHeatmap({ username }: { username: string }) {
  const { data: days, isLoading } = useQuery({
    queryKey: ["contributionGraph", username],
    queryFn: () => getContributionGraph(username),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contribution activity</CardTitle>
        {/* The backend exposes no contribution-graph endpoint, and deriving one
            from unrelated data would be inventing a feature. Said plainly here
            so the grid is never mistaken for this account's real activity. */}
        <CardDescription>
          Sample data — activity tracking isn&apos;t live yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !days ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="overflow-x-auto pb-1">
            <div className="flex w-max gap-1">
              {chunkIntoWeeks(days).map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col gap-1">
                  {week.map((day) => (
                    <Tooltip key={day.date}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn("size-3 rounded-sm", LEVEL_CLASS[day.count])}
                          aria-hidden="true"
                        />
                      </TooltipTrigger>
                      <TooltipContent>
                        {day.count} contribution{day.count === 1 ? "" : "s"} on{" "}
                        {new Date(day.date).toLocaleDateString("en", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
