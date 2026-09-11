import { Flame, GitBranch, Users } from "lucide-react";

import { PREVIEW_PROJECTS, WEEKLY_UPDATES } from "@/lib/mock/hero-preview";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The hero's product preview.
 *
 * The hero was a narrow centred column in a 1152px container: roughly 230px of
 * empty gutter down each side and a 260px dead band above the badge. Rather
 * than pad that out with decoration, this fills it with the thing the headline
 * is promising — a builder's dashboard part-way through a quarter. It also
 * answers "what do I actually get" above the fold, which the copy alone
 * cannot.
 *
 * Everything here is sample data and says so on the card. See
 * `@/lib/mock/hero-preview` for why one fictional builder's numbers are fair
 * game where platform-wide statistics are not.
 */

/* ── Chart geometry ────────────────────────────────────────────────────────
   Laid out in viewBox units and scaled by the browser. The paddings exist to
   keep the axis labels and the endpoint value *inside* the box — an SVG label
   placed at the edge of the plot is clipped, not just tight. */
const VIEW = { width: 520, height: 190 };
const PAD = { left: 30, right: 46, top: 18, bottom: 26 };
const PLOT_W = VIEW.width - PAD.left - PAD.right;
const PLOT_H = VIEW.height - PAD.top - PAD.bottom;

/** One scale for marks, ticks and labels alike. Headroom above the peak so the
 * endpoint marker is not welded to the top edge. */
const Y_MAX = 24;
/** Ticks the data actually reaches — an axis labelled up to a number no week
 * hit would be describing a chart that isn't on the screen. */
const Y_TICKS = [0, 10, 20];

const scaleX = (index: number) =>
  PAD.left + (index * PLOT_W) / (WEEKLY_UPDATES.length - 1);
const scaleY = (value: number) => PAD.top + PLOT_H - (value / Y_MAX) * PLOT_H;

const POINTS = WEEKLY_UPDATES.map((week, index) => ({
  ...week,
  x: scaleX(index),
  y: scaleY(week.count),
}));

const LINE_PATH = POINTS.map(
  (point, index) =>
    `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
).join(" ");

const AREA_PATH = `${LINE_PATH} L${POINTS[POINTS.length - 1].x.toFixed(1)},${scaleY(0)} L${POINTS[0].x.toFixed(1)},${scaleY(0)} Z`;

const LAST = POINTS[POINTS.length - 1];
const TOTAL_UPDATES = WEEKLY_UPDATES.reduce((sum, week) => sum + week.count, 0);

function MomentumChart() {
  return (
    <svg
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      className="h-auto w-full"
      role="img"
      aria-label={`Updates shipped each week over the last twelve weeks, rising from ${WEEKLY_UPDATES[0].count} to ${LAST.count}.`}
    >
      <defs>
        <linearGradient id="hero-momentum-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Grid and axis labels stay recessive: the line is the subject, and a
          grid drawn at the same weight as the data competes with it. */}
      <g className="text-muted-foreground/60">
        {Y_TICKS.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + PLOT_W}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="var(--border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={PAD.left - 8}
              y={scaleY(tick) + 3}
              textAnchor="end"
              fontSize="9"
              fill="currentColor"
            >
              {tick}
            </text>
          </g>
        ))}

        <text x={PAD.left} y={VIEW.height - 8} fontSize="9" fill="currentColor">
          12 weeks ago
        </text>
        <text
          x={PAD.left + PLOT_W}
          y={VIEW.height - 8}
          textAnchor="end"
          fontSize="9"
          fill="currentColor"
        >
          This week
        </text>
      </g>

      <path d={AREA_PATH} fill="url(#hero-momentum-fill)" />
      <path
        d={LINE_PATH}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* The endpoint carries a permanent label. Labelling all twelve points
          would be a table pretending to be a chart; labelling the one the eye
          lands on last gives the shape a number to land on. */}
      <circle cx={LAST.x} cy={LAST.y} r="4" fill="var(--primary)" />
      <text
        x={LAST.x + 10}
        y={LAST.y + 4}
        fontSize="11"
        fontWeight="600"
        className="fill-primary"
      >
        {LAST.count}
      </text>

      {/* Per-week hover. The hit area is a full-height column, far larger than
          the 5px dot it reveals, so the value is reachable without precision
          aiming. CSS-only — no state, no rerenders. */}
      {POINTS.map((point, index) => (
        <g key={point.label} className="group/point">
          <rect
            x={point.x - PLOT_W / (POINTS.length - 1) / 2}
            y={PAD.top}
            width={PLOT_W / (POINTS.length - 1)}
            height={PLOT_H}
            fill="transparent"
          />
          <circle
            cx={point.x}
            cy={point.y}
            r="3.5"
            fill="var(--primary)"
            className="opacity-0 transition-opacity group-hover/point:opacity-100"
          />
          {index !== POINTS.length - 1 && (
            <text
              x={point.x}
              y={point.y - 9}
              textAnchor="middle"
              fontSize="10"
              fontWeight="600"
              className="fill-primary opacity-0 transition-opacity group-hover/point:opacity-100"
            >
              {point.count}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function SummaryStat({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof Flame;
  value: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <p className="text-sm">
        <span className="font-display font-semibold tabular-nums">{value}</span>{" "}
        <span className="text-muted-foreground">{label}</span>
      </p>
    </div>
  );
}

export function HeroPreview() {
  return (
    <div className="grid w-full gap-4 text-left md:grid-cols-3">
      <Card className="glass md:col-span-2">
        <CardHeader className="flex-row items-baseline justify-between gap-4 pb-4">
          <CardTitle className="text-base">Momentum</CardTitle>
          <p className="text-muted-foreground/70 text-xs">
            Sample project · updates shipped per week
          </p>
        </CardHeader>
        <CardContent className="pb-5">
          <MomentumChart />

          <div className="border-border mt-5 flex flex-wrap items-center gap-x-7 gap-y-3 border-t pt-4">
            <SummaryStat
              icon={GitBranch}
              value={String(TOTAL_UPDATES)}
              label="updates this quarter"
            />
            <SummaryStat icon={Users} value="8" label="collaborators" />
            <SummaryStat icon={Flame} value="34" label="day streak" />
          </div>
        </CardContent>
      </Card>

      <Card className="glass flex flex-col">
        <CardHeader className="pb-4">
          <CardTitle className="text-base">Roadmap</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-5 pb-5">
          {PREVIEW_PROJECTS.map((project) => (
            <div key={project.name}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-sm font-medium">{project.name}</p>
                <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {project.progressPercent}%
                </p>
              </div>
              <div className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full">
                {/* Green only at completion. A progress bar that turns green
                    at 80% is telling the reader something the number isn't. */}
                <div
                  className={cn(
                    "h-full rounded-full",
                    project.progressPercent === 100 ? "bg-success" : "bg-primary",
                  )}
                  style={{ width: `${project.progressPercent}%` }}
                />
              </div>
              <p className="text-muted-foreground/70 mt-1.5 text-xs">{project.status}</p>
            </div>
          ))}

          {/* `mt-auto` pins this to the bottom of the card. The two cards sit
              in one grid row, so this one is stretched to the chart's height
              and the three bars alone left about 110px of dead space under
              them — the same emptiness this panel exists to remove.

              It earns its place rather than merely filling: recruiting is the
              half of the headline's promise the rest of the panel doesn't
              show, and an open role is how that actually happens here. */}
          <div className="border-border mt-auto border-t pt-4">
            <p className="text-muted-foreground/70 text-[0.65rem] font-semibold tracking-[0.14em] uppercase">
              Open role
            </p>
            <p className="mt-2 text-sm font-medium">Backend engineer</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Northwind Atlas · 4 builders applied
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
