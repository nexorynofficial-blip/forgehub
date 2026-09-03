"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { queryKeys } from "@/lib/query-keys";
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

  /**
   * The watermark `GET /feed/new-count` counts from.
   *
   * A ref rather than state because moving it must not re-render the list —
   * it advances only when the reader chooses to catch up. The mock had nothing
   * like this: it counted its own poll ticks and invented a 2 on the third.
   */
  const seenSince = useRef(new Date().toISOString());

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useInfiniteQuery({
      queryKey: queryKeys.feed(filter),
      queryFn: ({ pageParam }) => getFeedPage({ filter, cursor: pageParam }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  useQuery({
    queryKey: ["feed", filter, "new-count"],
    queryFn: async () => {
      const count = await checkForNewPosts(filter, seenSince.current);
      setNewPostCount(count);
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

  /**
   * Switching filters resets the watermark: "12 new posts since you arrived"
   * is a claim about the list you are looking at, and carrying it across a
   * filter change would count posts against the wrong query.
   */
  const handleFilterChange = useCallback((next: FeedFilter) => {
    seenSince.current = new Date().toISOString();
    setNewPostCount(0);
    setFilter(next);
  }, []);

  function handleShowNewPosts() {
    seenSince.current = new Date().toISOString();
    setNewPostCount(0);
    void queryClient.invalidateQueries({ queryKey: queryKeys.feed(filter) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const posts = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PostComposer activeFilter={filter} />
      <FeedFilters value={filter} onChange={handleFilterChange} />
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
