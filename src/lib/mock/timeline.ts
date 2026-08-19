import type { ActivityItem } from "@/types";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Per-profile timeline entries (UI_UX.md §8 "Timeline"), keyed by username.
 * Reuses `ActivityItem` (src/types/marketing.ts) rather than a new type —
 * same shape as the landing page's live feed, just scoped to one builder. */
export const mockProfileTimelines: Record<string, ActivityItem[]> = {
  "ava.codes": [
    {
      id: "tl_001",
      kind: "milestone",
      actorName: "Ava Whitfield",
      actorAvatarUrl: null,
      message: "hit 1,000 followers on ForgeHub",
      occurredAt: daysAgo(15),
    },
    {
      id: "tl_002",
      kind: "launch",
      actorName: "Ava Whitfield",
      actorAvatarUrl: null,
      message: "launched Coastline CRM",
      occurredAt: daysAgo(48),
    },
    {
      id: "tl_003",
      kind: "collaboration",
      actorName: "Ava Whitfield",
      actorAvatarUrl: null,
      message: "joined the Northwind Atlas team as a contributor",
      occurredAt: daysAgo(63),
    },
    {
      id: "tl_004",
      kind: "follow",
      actorName: "Ava Whitfield",
      actorAvatarUrl: null,
      message: "started following 8 builders in Systems Design",
      occurredAt: daysAgo(90),
    },
  ],
  "dana.builds": [
    {
      id: "tl_101",
      kind: "milestone",
      actorName: "Dana Okafor",
      actorAvatarUrl: null,
      message: "hit 1,000 users on Tidal Notes",
      occurredAt: daysAgo(2),
    },
    {
      id: "tl_102",
      kind: "launch",
      actorName: "Dana Okafor",
      actorAvatarUrl: null,
      message: "launched Tidal Notes v2.0",
      occurredAt: daysAgo(30),
    },
  ],
  "riko.tanaka": [
    {
      id: "tl_201",
      kind: "launch",
      actorName: "Riko Tanaka",
      actorAvatarUrl: null,
      message: "launched Pixelforge, an in-browser sprite editor",
      occurredAt: daysAgo(4),
    },
  ],
};
