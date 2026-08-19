import type { UpcomingEvent } from "@/types";

const daysFromNow = (days: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

export const mockUpcomingEvents: UpcomingEvent[] = [
  {
    id: "evt_001",
    title: "AI Tooling: Show & Tell",
    communityName: "AI Tooling",
    startsAt: daysFromNow(1, 18),
    isOnline: true,
    attendeeCount: 64,
  },
  {
    id: "evt_002",
    title: "Indie SaaS Office Hours",
    communityName: "Indie SaaS",
    startsAt: daysFromNow(3, 17),
    isOnline: true,
    attendeeCount: 31,
  },
  {
    id: "evt_003",
    title: "Design Systems Meetup",
    communityName: "Design Systems",
    startsAt: daysFromNow(5, 12),
    isOnline: false,
    attendeeCount: 22,
  },
];
