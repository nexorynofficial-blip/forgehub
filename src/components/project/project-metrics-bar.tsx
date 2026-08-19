import { Eye, Heart, TrendingUp, Users } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import type { Project } from "@/types";
import { Card } from "@/components/ui/card";

/** UI_UX.md §9 "Metrics". */
export function ProjectMetricsBar({ project }: { project: Project }) {
  const stats = [
    { label: "Views", value: formatCompactNumber(project.metrics.views), icon: Eye },
    { label: "Likes", value: formatCompactNumber(project.metrics.likes), icon: Heart },
    {
      label: "Followers",
      value: formatCompactNumber(project.metrics.followers),
      icon: Users,
    },
    { label: "Progress", value: `${project.progressPercent}%`, icon: TrendingUp },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {stats.map((stat) => (
        <Card
          key={stat.label}
          className="flex flex-col items-center gap-1 p-4 text-center"
        >
          <stat.icon className="text-muted-foreground size-4" />
          <p className="font-display text-lg font-semibold">{stat.value}</p>
          <p className="text-muted-foreground text-xs">{stat.label}</p>
        </Card>
      ))}
    </div>
  );
}
