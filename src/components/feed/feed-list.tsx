"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { checkForNewPosts, getFeedPage } from "@/lib/services/feed-service";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import type { FeedFilter } from "@/types";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FeedFilters } from "@/components/feed/feed-filters";
import { NewPostsPill } from "@/components/feed/new-posts-pill";
import { PostCard } from "@/components/feed/post-card";
import { PostComposer } from "@/components/feed/post-composer";

function PostSkeleton() {
  return (
    <Card className="p-5">
      <div className="flex gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-3/4" />
        </div>
      </div>
    </Card>
  );
}

/** UI_UX.md §10 "Infinite Scroll" — a bottom sentinel observed via
 * IntersectionObserver calls `fetchNextPage()`. */
export function FeedList() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FeedFilter>("trending");
  const [newPostCount, setNewPostCount] = useState(0);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: ["feed", filter],
      queryFn: ({ pageParam }) => getFeedPage({ filter, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  useQuery({
    queryKey: ["feedNewPostsCheck"],
    queryFn: async () => {
      const count = await checkForNewPosts();
      if (count > 0) setNewPostCount(count);
      return count;
    },
    refetchInterval: 15_000,
  });

  const { ref: sentinelRef, isIntersecting } = useIntersectionObserver<HTMLDivElement>({
    rootMargin: "400px",
  });

  useEffect(() => {
    if (isIntersecting && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [isIntersecting, hasNextPage, isFetchingNextPage, fetchNextPage]);

  function handleShowNewPosts() {
    setNewPostCount(0);
    queryClient.invalidateQueries({ queryKey: ["feed", filter] });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const posts = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PostComposer activeFilter={filter} />
      <FeedFilters value={filter} onChange={setFilter} />
      <NewPostsPill count={newPostCount} onClick={handleShowNewPosts} />

      {isLoading ? (
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <PostSkeleton key={i} />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">
            Nothing here yet — follow a few builders to fill this feed.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      )}

      {hasNextPage && (
        <div ref={sentinelRef} className="flex justify-center py-4">
          {isFetchingNextPage && (
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          )}
        </div>
      )}
    </div>
  );
}
