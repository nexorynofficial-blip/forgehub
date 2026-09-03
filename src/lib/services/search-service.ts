import { api, type Pagination } from "@/lib/api";

/**
 * Search (`backend/src/modules/search`).
 *
 * One endpoint, five entity groups, always all five present — a filtered-out
 * group comes back empty rather than absent, so nothing here has to branch on
 * whether a key exists.
 *
 * The frontend does **no** filtering of its own. The backend evaluates every
 * result against the caller's visibility (private profiles, unlisted
 * communities, blocks) and returns only what this viewer may see; re-filtering
 * here could only ever hide something legitimate, and could never reveal
 * something withheld. Wildcards are likewise the backend's business — it
 * refuses a wildcard-only query itself.
 */

export const SEARCH_ENTITIES = [
  "users",
  "projects",
  "communities",
  "posts",
  "tags",
] as const;

export type SearchEntity = (typeof SEARCH_ENTITIES)[number];
export type SearchType = "all" | SearchEntity;
export type SearchSort = "recent" | "popular";

/** One page of one entity group, with a count scoped to *visible* matches. */
export interface SearchGroup<T> {
  items: T[];
  pagination: Pagination;
}

export interface UserSearchResult {
  id: string;
  username: string;
  displayName: string;
  builderRank: string;
  avatarUrl: string | null;
  bio: string | null;
}

export interface ProjectSearchResult {
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
  owner: UserSearchResult | null;
  tags: string[];
}

export interface CommunitySearchResult {
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

export interface PostSearchResult {
  id: string;
  type: string;
  content: string;
  visibility: string;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
  author: UserSearchResult | null;
}

export interface TagSearchResult {
  id: string;
  slug: string;
  name: string;
  usageCount: number;
}

/** The whole response, grouped. Nothing is flattened away. */
export interface SearchResults {
  query: string;
  type: SearchType;
  sort: SearchSort;
  users: SearchGroup<UserSearchResult>;
  projects: SearchGroup<ProjectSearchResult>;
  communities: SearchGroup<CommunitySearchResult>;
  posts: SearchGroup<PostSearchResult>;
  tags: SearchGroup<TagSearchResult>;
  /** Sum of the five visible totals. Zero is an ordinary result, not a 404. */
  totalResults: number;
}

/**
 * `GET /search`.
 *
 * `q` is required and the backend rejects an empty or wildcard-only term with
 * a 422, so callers should not fire on an empty input — the topbar guards on
 * a minimum length rather than relying on the error.
 */
export async function search(params: {
  q: string;
  type?: SearchType;
  sort?: SearchSort;
  page?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<SearchResults> {
  const { signal, ...query } = params;
  return api.get<SearchResults>("/search", { query, ...(signal ? { signal } : {}) });
}

/** The groups in the order the response presents them, for rendering. */
export function groupsOf(results: SearchResults) {
  return [
    { key: "users" as const, label: "People", group: results.users },
    { key: "projects" as const, label: "Projects", group: results.projects },
    { key: "communities" as const, label: "Communities", group: results.communities },
    { key: "posts" as const, label: "Posts", group: results.posts },
    { key: "tags" as const, label: "Tags", group: results.tags },
  ];
}
