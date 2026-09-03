import type { FollowerPreview, ProfileRelationship } from "@/types";
import { api } from "@/lib/api";

/**
 * The social graph (`backend/src/modules/follows`).
 *
 * Every target is addressed by **username**, never by id — that is what a
 * profile page has in hand, and it is what the backend's route params accept.
 * The actor is always the token holder and is never sent in a payload.
 */

/** `POST|DELETE /users/{username}/follow` response. */
export interface FollowMutationResult {
  following: boolean;
  /** The *target's* follower count after the change, so the header can update
   * from the response instead of refetching the profile. */
  followersCount: number;
  relationship: ProfileRelationship;
}

/** `POST|DELETE /users/{username}/block` response. */
export interface BlockMutationResult {
  blocking: boolean;
  /** Follow rows the block destroyed, in both directions. The backend owns
   * this cleanup; the frontend reports it rather than reproducing it. */
  followsRemoved: number;
}

function path(username: string, suffix: string): string {
  return `/users/${encodeURIComponent(username)}/${suffix}`;
}

export async function followUser(username: string): Promise<FollowMutationResult> {
  return api.post<FollowMutationResult>(path(username, "follow"));
}

export async function unfollowUser(username: string): Promise<FollowMutationResult> {
  return api.delete<FollowMutationResult>(path(username, "follow"));
}

/**
 * Blocking is not just "stop seeing them": the backend also tears down any
 * follow rows in both directions and hides each party from the other. The UI
 * reacts to what comes back; it does not re-implement those rules.
 */
export async function blockUser(username: string): Promise<BlockMutationResult> {
  return api.post<BlockMutationResult>(path(username, "block"));
}

export async function unblockUser(username: string): Promise<BlockMutationResult> {
  return api.delete<BlockMutationResult>(path(username, "block"));
}

/** `GET /users/{username}/relationship` — authenticated viewers only. */
export async function getRelationship(username: string): Promise<ProfileRelationship> {
  const { relationship } = await api.get<{ relationship: ProfileRelationship }>(
    path(username, "relationship"),
  );
  return relationship;
}

export interface BlockedPage {
  items: FollowerPreview[];
  nextCursor: string | null;
}

/**
 * `GET /users/me/blocks` — the caller's own block list, never exposed for
 * anyone else. Cursor-paginated like the follower lists.
 */
export async function getBlockedUsers(
  options: { cursor?: string; limit?: number } = {},
): Promise<BlockedPage> {
  return api.get<BlockedPage>("/users/me/blocks", {
    query: { cursor: options.cursor, limit: options.limit },
  });
}
