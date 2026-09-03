"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { getWeeklySignups } from "@/lib/services/admin-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const WIDTH = 560;
const HEIGHT = 220;
const PADDING = { top: 16, right: 12, bottom: 28, left: 44 };

function niceMax(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

/** PRD.md §4.12 "Analytics" — single-series bar chart, so one hue (the
 * brand primary) with no legend, per the dataviz skill's "1–3 series: color
 * alone is comfortable, direct-label" guidance. See docs/ASSUMPTIONS.md
 * (Phase 11) for why this uses hand-rolled SVG rather than a charting
 * library. */
export function WeeklySignupsChart() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.adminSignups,
    queryFn: getWeeklySignups,
  });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly signups</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <SignupsChartBody data={data} hoverIndex={hoverIndex} onHover={setHoverIndex} />
        )}
      </CardContent>
    </Card>
  );
}

function SignupsChartBody({
  data,
  hoverIndex,
  onHover,
}: {
  data: { weekLabel: string; count: number }[];
  hoverIndex: number | null;
  onHover: (index: number | null) => void;
}) {
  const innerWidth = WIDTH - PADDING.left - PADDING.right;
  const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const maxValue = niceMax(Math.max(...data.map((d) => d.count)));
  const barSlot = innerWidth / data.length;
  const barWidth = Math.min(24, barSlot * 0.55);
  const yTicks = [0, maxValue / 2, maxValue];

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label="Weekly signups, last 8 weeks"
      >
        {yTicks.map((tick) => {
          const y = PADDING.top + innerHeight - (tick / maxValue) * innerHeight;
          return (
            <g key={tick}>
              <line
                x1={PADDING.left}
                x2={WIDTH - PADDING.right}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PADDING.left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {Math.round(tick).toLocaleString()}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const barHeight = Math.max((d.count / maxValue) * innerHeight, 2);
          const x = PADDING.left + i * barSlot + (barSlot - barWidth) / 2;
          const y = PADDING.top + innerHeight - barHeight;
          const isHovered = hoverIndex === i;

          return (
            <g key={d.weekLabel}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
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
                aria-label={`${d.weekLabel}: ${d.count.toLocaleString()} signups`}
              />
              <text
                x={x + barWidth / 2}
                y={HEIGHT - PADDING.bottom + 16}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {d.weekLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {hoverIndex !== null && (
        <div
          className="border-border-strong bg-card pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-[var(--shadow-floating)]"
          style={{
            left: `${((PADDING.left + hoverIndex * barSlot + barSlot / 2) / WIDTH) * 100}%`,
            top: 0,
          }}
        >
          <p className="text-foreground font-semibold">
            {data[hoverIndex].count.toLocaleString()}
          </p>
          <p className="text-muted-foreground">{data[hoverIndex].weekLabel}</p>
        </div>
      )}
    </div>
  );
}
