"use client";

import { useQuery } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { getCommunityPinnedPosts } from "@/lib/services/community-service";
import { Skeleton } from "@/components/ui/skeleton";
import { PostCard } from "@/components/feed/post-card";

/** PRD.md §4.6 "Pinned Posts" — reuses Feed's `PostCard` as-is, now resolved
 * from the community's real pin list rather than the mock post pool. */
export function CommunityPinnedPosts({ slug }: { slug: string }) {
  const { data: posts, isLoading } = useQuery({
    queryKey: queryKeys.communityPins(slug),
    queryFn: () => getCommunityPinnedPosts(slug),
  });

  if (!isLoading && posts?.length === 0) return null;

  return (
    <div>
      <h2 className="font-display mb-3 text-lg font-semibold tracking-tight">
        Pinned posts
      </h2>
      {isLoading || !posts ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}
    </div>
  );
}
