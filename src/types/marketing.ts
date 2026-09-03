import type { ID, ISODateString } from "./common";

/**
 * Presentation-layer types for the public marketing site (landing page and
 * beyond). Unlike src/types/user.ts etc., these don't map to a TRD.md §4
 * entity 1:1 — they're shaped for what the landing page renders, backed by
 * services that would plausibly hit an Analytics/CMS-style endpoint later.
 */

export interface Testimonial {
  id: ID;
  quote: string;
  authorName: string;
  authorRole: string;
  authorAvatarUrl: string | null;
}

export type ActivityKind = "launch" | "milestone" | "follow" | "collaboration";

export interface ActivityItem {
  id: ID;
  kind: ActivityKind;
  actorName: string;
  actorAvatarUrl: string | null;
  message: string;
  occurredAt: ISODateString;
}

export interface FeaturedBuilder {
  id: ID;
  name: string;
  role: string;
  avatarUrl: string | null;
}

export interface FeaturedCommunity {
  id: ID;
  name: string;
  memberCount: number;
  category: string;
}
