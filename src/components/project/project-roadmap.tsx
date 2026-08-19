import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Milestone } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function MilestoneRow({ milestone, isLast }: { milestone: Milestone; isLast: boolean }) {
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {!isLast && (
        <span
          className="bg-border absolute top-7 bottom-0 left-3.5 w-px"
          aria-hidden="true"
        />
      )}
      <span
        className={cn(
          "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full",
          milestone.isComplete
            ? "bg-success/15 text-success"
            : "border-border-strong text-muted-foreground border-2",
        )}
      >
        {milestone.isComplete && <Check className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p
            className={cn(
              "text-sm font-medium",
              !milestone.isComplete && "text-muted-foreground",
            )}
          >
            {milestone.title}
          </p>
          {milestone.targetDate && (
            <time className="text-muted-foreground text-xs">
              {new Date(milestone.targetDate).toLocaleDateString("en", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-sm">{milestone.description}</p>
      </div>
    </li>
  );
}

/** UI_UX.md §9 "Progress Timeline" + "Roadmap" — both bullets render from
 * the same `milestones` data, so they're one section here rather than two
 * near-duplicates. See docs/ASSUMPTIONS.md (Phase 07). */
export function ProjectRoadmap({
  progressPercent,
  milestones,
}: {
  progressPercent: number;
  milestones: Milestone[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Roadmap</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-6">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Overall progress</span>
            <span className="font-medium">{progressPercent}%</span>
          </div>
          <div className="bg-muted mt-2 h-2 overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {milestones.length === 0 ? (
          <p className="text-muted-foreground text-sm">No milestones yet.</p>
        ) : (
          <ul>
            {milestones.map((milestone, index) => (
              <MilestoneRow
                key={milestone.id}
                milestone={milestone}
                isLast={index === milestones.length - 1}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
