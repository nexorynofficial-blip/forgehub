import type { UserPreviewView, RelationshipView } from "../users/users.types.js";

/**
 * Contracts for the social graph module.
 *
 * List entries use `UserPreviewView`, which mirrors the frontend's
 * `FollowerPreview` (`src/types/profile.ts`) — the shape `FollowersWidget`
 * and `AvatarStackDialog` already render.
 */

/** Response to follow / unfollow. Carries the counter so the profile header
 * can update without a refetch. */
export interface FollowMutationResult {
  following: boolean;
  /** The *target's* follower count after the change. */
  followersCount: number;
  relationship: RelationshipView;
}

export interface BlockMutationResult {
  blocking: boolean;
  /** How many follow rows the block destroyed, across both directions. */
  followsRemoved: number;
}

export interface FollowListPage {
  items: UserPreviewView[];
  nextCursor: string | null;
}

export type { UserPreviewView, RelationshipView };
