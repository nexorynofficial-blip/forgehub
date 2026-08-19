import type { CommunityEvent } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** PRD.md §4.6 "Events". */
export function CommunityEvents({ events }: { events: CommunityEvent[] }) {
  if (events.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming events</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-border divide-y">
          {events.map((event) => {
            const date = new Date(event.startsAt);
            const month = date.toLocaleDateString("en", { month: "short" }).toUpperCase();
            const day = date.getDate();
            const time = date.toLocaleTimeString("en", {
              hour: "numeric",
              minute: "2-digit",
            });

            return (
              <li key={event.id} className="flex items-center gap-3 py-3">
                <div className="border-border-strong bg-card flex size-11 shrink-0 flex-col items-center justify-center rounded-md border">
                  <span className="text-primary text-[10px] leading-none font-semibold">
                    {month}
                  </span>
                  <span className="font-display text-sm leading-tight font-semibold">
                    {day}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{event.title}</p>
                  <p className="text-muted-foreground text-xs">{time}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
