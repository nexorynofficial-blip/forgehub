import type {
  ActivityItem,
  ContributionDay,
  FollowerPreview,
  ProfileResult,
} from "@/types";
import { ApiError, api } from "@/lib/api";
import { getMockContributionGraph } from "@/lib/mock/contributions";
import { mockProfileTimelines } from "@/lib/mock/timeline";

/**
 * Public profiles and the follower/following lists (`backend/src/modules/users`
 * and `.../follows`).
 *
 * Two widgets on this page have no backend behind them — see the bottom of the
 * file. They are the only mocks left here, and they are labelled rather than
 * quietly dressed up as real data.
 */

/** How many previews the followers widget's avatar stack needs. */
export const FOLLOWER_PREVIEW_LIMIT = 12;

/**
 * `GET /users/{username}` — returns the profile *and* the viewer's
 * relationship to it, so the header needs no second request.
 *
 * A 404 becomes `null`. That is not lossy: the backend deliberately answers
 * 404 — never 403 — for a profile that exists but is blocked or otherwise
 * invisible, so "no such profile" and "not for you" are the same answer by
 * design, and the frontend must not try to tell them apart.
 */
export async function getProfile(username: string): Promise<ProfileResult | null> {
  try {
    return await api.get<ProfileResult>(`/users/${encodeURIComponent(username)}`);
  } catch (error) {
    if (error instanceof ApiError && error.isNotFound) return null;
    throw error;
  }
}

/** Cursor page shape for the social-graph lists. No `total` — the backend's
 * `FollowListPage` carries only the items and the next cursor. */
export interface FollowerPage {
  items: FollowerPreview[];
  nextCursor: string | null;
}

/** `GET /users/{username}/followers`. */
export async function getFollowers(
  username: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<FollowerPage> {
  return api.get<FollowerPage>(`/users/${encodeURIComponent(username)}/followers`, {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/** `GET /users/{username}/following`. */
export async function getFollowing(
  username: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<FollowerPage> {
  return api.get<FollowerPage>(`/users/${encodeURIComponent(username)}/following`, {
    query: { cursor: options.cursor, limit: options.limit },
  });
}

/**
 * One bounded page of followers for the profile widget's avatar stack.
 *
 * The widget shows a preview, not the whole graph, so it asks for one small
 * page rather than paging to exhaustion — the list is cursor-paginated
 * precisely because it can be large.
 */
export async function getFollowerPreviews(username: string): Promise<FollowerPreview[]> {
  const page = await getFollowers(username, { limit: FOLLOWER_PREVIEW_LIMIT });
  return page.items;
}

/* ── Not backed by the API ────────────────────────────────────────────────── */

/**
 * **Deferred — no backend endpoint exists.**
 *
 * There is no contribution-graph route anywhere in the backend's 133
 * operations, and deriving one from posts/projects would be inventing a
 * product feature under the guise of integration. The fixture is kept so the
 * shipped widget still renders its intended shape, and the widget labels it as
 * sample data so nobody mistakes it for this user's real activity.
 */
export async function getContributionGraph(username: string): Promise<ContributionDay[]> {
  return getMockContributionGraph(username);
}

/**
 * **Deferred — no backend endpoint exists.**
 *
 * Same reasoning as the contribution graph. `/users/{username}/posts` exists
 * but is a post list, not an activity timeline, and Phase 4 owns it; mapping
 * one onto the other would be fabricating semantics the API never promised.
 */
export async function getProfileTimeline(username: string): Promise<ActivityItem[]> {
  return mockProfileTimelines[username] ?? [];
}
