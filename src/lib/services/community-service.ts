import type { Community, FollowerPreview, PostAuthor, PostWithAuthor } from "@/types";
import { mockCommunities } from "@/lib/mock/communities";
import { mockFollowerPreviews } from "@/lib/mock/followers";
import { resolvePersonById } from "@/lib/mock/people";
import { mockPosts } from "@/lib/mock/posts";

/** Placeholder for the Community API (TRD.md §5). */

export async function getCommunities(): Promise<Community[]> {
  return mockCommunities;
}

export async function getCommunityBySlug(slug: string): Promise<Community | null> {
  return mockCommunities.find((community) => community.slug === slug) ?? null;
}

export async function getCommunityModerators(
  community: Community,
): Promise<PostAuthor[]> {
  return community.moderatorIds
    .map((id) => resolvePersonById(id))
    .filter((person): person is PostAuthor => person !== null);
}

export async function getCommunityPinnedPosts(
  community: Community,
): Promise<PostWithAuthor[]> {
  return community.pinnedPostIds
    .map((id) => mockPosts.find((post) => post.id === id))
    .filter((post): post is PostWithAuthor => post !== undefined);
}

/** Shared preview pool across every community in this demo — same
 * reasoning as Phase 05's `getFollowerPreviews`; there's no real
 * membership graph to seed yet. See docs/ASSUMPTIONS.md (Phase 08). */
export async function getCommunityMemberPreviews(): Promise<FollowerPreview[]> {
  return mockFollowerPreviews;
}
