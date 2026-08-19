import type { ID, ISODateString } from "./common";

/**
 * Presentation-layer types for the profile page (Phase 05), same convention
 * as src/types/marketing.ts and src/types/dashboard.ts.
 */

export interface ContributionDay {
  date: ISODateString;
  count: number;
}

export interface FollowerPreview {
  id: ID;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}
