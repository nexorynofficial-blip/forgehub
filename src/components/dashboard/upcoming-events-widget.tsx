"use client";

import { useQuery } from "@tanstack/react-query";
import { MapPin, Video } from "lucide-react";

import { getUpcomingEvents } from "@/lib/services/dashboard-service";
import type { UpcomingEvent } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function EventRow({ event }: { event: UpcomingEvent }) {
  const date = new Date(event.startsAt);
  const month = date.toLocaleDateString("en", { month: "short" }).toUpperCase();
  const day = date.getDate();

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="border-border-strong bg-card flex size-11 shrink-0 flex-col items-center justify-center rounded-md border">
        <span className="text-primary text-[10px] leading-none font-semibold">
          {month}
        </span>
        <span className="font-display text-sm leading-tight font-semibold">{day}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{event.title}</p>
        <p className="text-muted-foreground truncate text-xs">{event.communityName}</p>
      </div>
      <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
        {event.isOnline ? (
          <Video className="size-3.5" />
        ) : (
          <MapPin className="size-3.5" />
        )}
        {event.attendeeCount}
      </span>
    </li>
  );
}

/**
 * UI_UX.md §7 "Upcoming Events" (PRD.md §4.6 Community Events).
 *
 * Events exist per community; there is no global upcoming-events endpoint, and
 * fanning out across every community the user belongs to would be an unbounded
 * number of requests standing in for a missing API. The card reports that
 * plainly instead.
 */
export function UpcomingEventsWidget() {
  const { data: events, isLoading } = useQuery({
    queryKey: ["upcomingEvents"],
    queryFn: getUpcomingEvents,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upcoming events</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !events ? (
          <ul className="divide-border divide-y">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 py-3">
                <Skeleton className="size-11 shrink-0 rounded-md" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))}
          </ul>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            A combined events calendar is not available yet.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
