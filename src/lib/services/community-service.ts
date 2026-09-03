import type {
  Community,
  CommunityEvent,
  FollowerPreview,
  PostAuthor,
  PostWithAuthor,
} from "@/types";
import { ApiError, api } from "@/lib/api";
import { getPost } from "@/lib/services/feed-service";

/**
 * Communities (`backend/src/modules/communities`).
 *
 * `CommunityView` mirrors the frontend's `Community` and adds `visibility`,
 * `ownerId` and an embedded `owner`, so the page needs no adapter — only the
 * envelope keys unwrapped.
 *
 * Every list here is **cursor**-paginated, including discovery. That is worth
 * stating because projects and admin are offset: reaching for `getPaginated`
 * on these routes would silently produce an empty page.
 */

/** Extras the backend returns beyond the shipped `Community` type. */
export interface CommunityDetail extends Community {
  visibility: "public" | "private" | "unlisted";
  ownerId: string;
  owner: PostAuthor;
}

/** The discovery-card projection — deliberately lighter than the full view. */
export interface CommunitySummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  category: string;
  tags: string[];
  memberCount: number;
  createdAt: string;
  visibility: "public" | "private" | "unlisted";
}

/**
 * The viewer's standing in a community. Null for anonymous viewers.
 *
 * `canJoin` is computed server-side rather than inferred from `visibility`
 * here, because the join rules differ per visibility and a client that
 * re-derived them would drift from the server that enforces them.
 */
export interface CommunityViewerState {
  isOwner: boolean;
  isMember: boolean;
  role: string | null;
  canJoin: boolean;
  canPost: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canModerate: boolean;
}

export interface CommunityResult {
  community: CommunityDetail;
  viewer: CommunityViewerState | null;
}

export interface CommunityMemberEntry {
  userId: string;
  role: string;
  joinedAt: string;
  user: PostAuthor;
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/* ── Discovery & detail ───────────────────────────────────────────────────── */

/** `GET /communities` — cursor-paginated discovery. */
export async function getCommunities(
  options: { cursor?: string; limit?: number; category?: string; q?: string } = {},
): Promise<CursorPage<CommunitySummary>> {
  return api.get<CursorPage<CommunitySummary>>("/communities", {
    query: {
      cursor: options.cursor,
      limit: options.limit,
      category: options.category,
      q: options.q,
    },
  });
}

/**
 * `GET /communities/{slug}`.
 *
 * A 404 becomes `null`. A private community the viewer cannot see answers 404,
 * never 403 — the same non-disclosure rule the whole API follows.
 */
export async function getCommunityBySlug(slug: string): Promise<CommunityResult | null> {
  try {
    return await api.get<CommunityResult>(`/communities/${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/** `GET /communities/{slug}/moderators` — owner and admins included. */
export async function getCommunityModerators(slug: string): Promise<PostAuthor[]> {
  const { moderators } = await api.get<{ moderators: PostAuthor[] }>(
    `/communities/${encodeURIComponent(slug)}/moderators`,
  );
  return moderators;
}

/** `GET /communities/{slug}/members` — cursor-paginated, user embedded. */
export async function getCommunityMembers(
  slug: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CursorPage<CommunityMemberEntry>> {
  return api.get<CursorPage<CommunityMemberEntry>>(
    `/communities/${encodeURIComponent(slug)}/members`,
    { query: { cursor: options.cursor, limit: options.limit } },
  );
}

/** How many members the sidebar avatar stack previews. */
const MEMBER_PREVIEW_LIMIT = 12;

/**
 * One bounded page of members for the avatar stack.
 *
 * The shipped mock returned the same shared preview pool for every community
 * because there was no membership graph. There is one now, so this is that
 * community's actual members.
 */
export async function getCommunityMemberPreviews(
  slug: string,
): Promise<FollowerPreview[]> {
  const page = await getCommunityMembers(slug, { limit: MEMBER_PREVIEW_LIMIT });
  return page.items.map((entry) => ({
    id: entry.user.id,
    username: entry.user.username,
    displayName: entry.user.displayName,
    avatarUrl: entry.user.avatarUrl,
  }));
}

/* ── Membership ───────────────────────────────────────────────────────────── */

/** `POST /communities/{slug}/join` — returns the refreshed viewer state. */
export async function joinCommunity(slug: string): Promise<CommunityViewerState> {
  const { viewer } = await api.post<{ viewer: CommunityViewerState }>(
    `/communities/${encodeURIComponent(slug)}/join`,
  );
  return viewer;
}

/** `DELETE /communities/{slug}/leave`. */
export async function leaveCommunity(slug: string): Promise<{ left: boolean }> {
  return api.delete(`/communities/${encodeURIComponent(slug)}/leave`);
}

/* ── Content ──────────────────────────────────────────────────────────────── */

/** `GET /communities/{slug}/posts` — cursor-paginated community feed. */
export async function getCommunityPosts(
  slug: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<CursorPage<PostWithAuthor>> {
  return api.get<CursorPage<PostWithAuthor>>(
    `/communities/${encodeURIComponent(slug)}/posts`,
    { query: { cursor: options.cursor, limit: options.limit } },
  );
}

/** `POST /communities/{slug}/posts`. */
export async function createCommunityPost(
  slug: string,
  content: string,
): Promise<PostWithAuthor> {
  const { post } = await api.post<{ post: PostWithAuthor }>(
    `/communities/${encodeURIComponent(slug)}/posts`,
    { content },
  );
  return post;
}

/**
 * The pinned posts, resolved to whole posts.
 *
 * `GET /communities/{slug}/pins` returns **ids only**, so each one is then
 * read through `GET /posts/{id}` — the documented way to read a post, not a
 * fan-out standing in for a missing bulk endpoint. The list is bounded (a
 * handful of pins per community by design), and any id that no longer resolves
 * — deleted, or now invisible to this viewer — is dropped rather than rendered
 * as a broken card.
 */
export async function getCommunityPinnedPosts(slug: string): Promise<PostWithAuthor[]> {
  const { pinnedPostIds } = await api.get<{ pinnedPostIds: string[] }>(
    `/communities/${encodeURIComponent(slug)}/pins`,
  );
  if (pinnedPostIds.length === 0) return [];

  const results = await Promise.all(pinnedPostIds.map((id) => getPost(id)));
  return results
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .map((result) => result.post);
}

/** `GET /communities/{slug}/events` — upcoming events for one community. */
export async function getCommunityEvents(
  slug: string,
  limit = 10,
): Promise<CommunityEvent[]> {
  const { events } = await api.get<{ events: CommunityEvent[] }>(
    `/communities/${encodeURIComponent(slug)}/events`,
    { query: { limit } },
  );
  return events;
}
