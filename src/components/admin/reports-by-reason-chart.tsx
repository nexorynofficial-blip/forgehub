"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { getReportsByReason } from "@/lib/services/admin-service";
import type { ReportReason } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const REASON_LABEL: Record<ReportReason, string> = {
  spam: "Spam",
  harassment: "Harassment",
  inappropriate_content: "Inappropriate content",
  impersonation: "Impersonation",
  other: "Other",
};

const WIDTH = 560;
const ROW_HEIGHT = 36;
const LABEL_WIDTH = 140;
const RIGHT_PADDING = 40;

/** PRD.md §4.12 "Analytics" / "Flagged Posts" breakdown — horizontal bars
 * since category names are longer than they'd fit on an x-axis (per the
 * dataviz skill's part-to-whole/magnitude guidance for long-named
 * categories). Single hue, no legend needed for one series. */
export function ReportsByReasonChart() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminReportsByReason,
    queryFn: getReportsByReason,
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reports by reason</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-48 w-full" />
        ) : data.length === 0 ? (
          <p className="text-muted-foreground text-sm">No reports yet.</p>
        ) : (
          <ReasonChartBody data={data} hoverIndex={hoverIndex} onHover={setHoverIndex} />
        )}
      </CardContent>
    </Card>
  );
}

function ReasonChartBody({
  data,
  hoverIndex,
  onHover,
}: {
  data: { reason: ReportReason; count: number }[];
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
}) {
  const height = data.length * ROW_HEIGHT + 8;
  const trackWidth = WIDTH - LABEL_WIDTH - RIGHT_PADDING;
  const maxValue = Math.max(...data.map((d) => d.count));

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="w-full"
      role="img"
      aria-label="Reports by reason"
    >
      {data.map((d, i) => {
        const barWidth = Math.max((d.count / maxValue) * trackWidth, 4);
        const y = i * ROW_HEIGHT + 4;
        const isHovered = hoverIndex === i;

        return (
          <g key={d.reason}>
            <text
              x={LABEL_WIDTH - 10}
              y={y + 12}
              textAnchor="end"
              className="fill-foreground text-xs"
            >
              {REASON_LABEL[d.reason]}
            </text>
            <rect
              x={LABEL_WIDTH}
              y={y}
              width={barWidth}
              height={24}
              rx={4}
              className={
                isHovered
                  ? "fill-primary cursor-pointer"
                  : "fill-primary/80 cursor-pointer"
              }
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(i)}
              onBlur={() => onHover(null)}
              tabIndex={0}
              role="img"
              aria-label={`${REASON_LABEL[d.reason]}: ${d.count} report${d.count === 1 ? "" : "s"}`}
            />
            <text
              x={LABEL_WIDTH + barWidth + 8}
              y={y + 16}
              className="fill-muted-foreground text-xs"
            >
              {d.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
