import type { ActivityItem } from "@/types";

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/** Timestamps are relative to load time so the "live" feed never looks stale in a demo. */
export const mockActivity: ActivityItem[] = [
  {
    id: "act_001",
    kind: "launch",
    actorName: "Riko Tanaka",
    actorAvatarUrl: null,
    message: "launched Pixelforge, an in-browser sprite editor",
    occurredAt: minutesAgo(4),
  },
  {
    id: "act_002",
    kind: "milestone",
    actorName: "Dana Okafor",
    actorAvatarUrl: null,
    message: "hit 1,000 users on Tidal Notes",
    occurredAt: minutesAgo(28),
  },
  {
    id: "act_003",
    kind: "collaboration",
    actorName: "Lena Brandt",
    actorAvatarUrl: null,
    message: "joined the Northwind team as a contributor",
    occurredAt: minutesAgo(56),
  },
  {
    id: "act_004",
    kind: "follow",
    actorName: "Theo Marchetti",
    actorAvatarUrl: null,
    message: "started following 12 builders in AI Tooling",
    occurredAt: minutesAgo(81),
  },
  {
    id: "act_005",
    kind: "milestone",
    actorName: "Amaka Chukwu",
    actorAvatarUrl: null,
    message: "shipped v2.0 of Ledgerline",
    occurredAt: minutesAgo(106),
  },
];
