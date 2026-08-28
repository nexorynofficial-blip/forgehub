import type { Pagination } from "../../utils/response.js";
import type { SearchSort, SearchType } from "./search.schema.js";

/**
 * Response shapes for the search module (Phase 10).
 *
 * Five entity groups, always all five present, built by construction
 * (ruling D14). A group the caller filtered out is an *empty* group rather
 * than an absent key: a client that renders five result tabs should not have
 * to branch on whether a key exists, and a stable shape is what lets the
 * OpenAPI contract describe one response instead of six.
 *
 * There is no `Notification`-style flat/nested duality here because there is
 * no shipped frontend contract to mirror — `src/lib/services/` has no search
 * service and `src/types/` has no search type. The shapes below therefore
 * follow the repository's own summary projections (`UserSummaryView`,
 * community/project/post summaries) rather than inventing a parallel family.
 */

/** One page of one entity type, with its own count of *visible* matches. */
export interface SearchGroup<T> {
  items: T[];
  /**
   * Scoped to this group. `total` counts only rows the viewer may see — the
   * same `where` clause that produced `items` — so a hidden row can never be
   * inferred from a count that does not match the page.
   */
  pagination: Pagination;
}

/**
 * A user result.
 *
 * Mirrors `UserSummaryView` (`users.types.ts`) plus `bio`, which is one of the
 * fields a result card needs to be explicable. **No `email`, no `role`, no
 * `status`, no counters that the profile endpoint gates** — search is the
 * widest read surface in the API and therefore the narrowest projection.
 */
export interface UserSearchResultView {
  id: string;
  username: string;
  displayName: string;
  builderRank: string;
  avatarUrl: string | null;
  bio: string | null;
}

export interface ProjectSearchResultView {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverImageUrl: string | null;
  status: string;
  visibility: string;
  likesCount: number;
  followersCount: number;
  createdAt: string;
  owner: UserSearchResultView | null;
  tags: string[];
}

export interface CommunitySearchResultView {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  category: string;
  visibility: string;
  memberCount: number;
  createdAt: string;
  tags: string[];
}

export interface PostSearchResultView {
  id: string;
  type: string;
  content: string;
  visibility: string;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
  author: UserSearchResultView | null;
}

export interface TagSearchResultView {
  id: string;
  slug: string;
  name: string;
  usageCount: number;
}

/** The whole response body. */
export interface SearchResultsView {
  /** Echoed back normalized, so a client can confirm what was actually run. */
  query: string;
  type: SearchType;
  sort: SearchSort;
  users: SearchGroup<UserSearchResultView>;
  projects: SearchGroup<ProjectSearchResultView>;
  communities: SearchGroup<CommunitySearchResultView>;
  posts: SearchGroup<PostSearchResultView>;
  tags: SearchGroup<TagSearchResultView>;
  /** Sum of the five visible totals. Zero is an ordinary outcome, not a 404. */
  totalResults: number;
}
