import type { ID, ISODateString } from "./common";

/** PRD.md §4.6 Communities */
export interface CommunityEvent {
  id: ID;
  title: string;
  startsAt: ISODateString;
  endsAt: ISODateString | null;
}

export interface Community {
  id: ID;
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  category: string;
  tags: string[];
  rules: string[];
  moderatorIds: ID[];
  memberCount: number;
  pinnedPostIds: ID[];
  events: CommunityEvent[];
  createdAt: ISODateString;
}
