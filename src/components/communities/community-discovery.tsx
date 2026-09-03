"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";

import { getCommunities } from "@/lib/services/community-service";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CommunityCard } from "@/components/communities/community-card";
import { CommunityFilters } from "@/components/communities/community-filters";

const PAGE_SIZE = 24;

/**
 * PRD.md §4.6 "Categories".
 *
 * Filtering moved from the browser to the server. The mock held every
 * community in one array, so filtering locally was complete; the real list is
 * cursor-paginated, and filtering only the loaded page would quietly report
 * "no communities match" for one sitting just past the page boundary.
 */
export function CommunityDiscovery() {
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  /**
   * A plain timeout rather than a debounce dependency — the project has none
   * and this does not justify adding one.
   */
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * The category tabs come from their own unfiltered query.
   *
   * Deriving them from the filtered results would make the tabs disappear as
   * soon as a search narrowed the list — including the tab the user is
   * standing on.
   */
  const { data: categorySource } = useQuery({
    queryKey: ["communities", "categories"],
    queryFn: () => getCommunities({ limit: 100 }),
    staleTime: 5 * 60 * 1000,
  });

  const categories = useMemo(
    () =>
      Array.from(
        new Set((categorySource?.items ?? []).map((community) => community.category)),
      ).sort(),
    [categorySource],
  );

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["communities", "list", category, debouncedSearch],
      queryFn: ({ pageParam }) =>
        getCommunities({
          cursor: pageParam ?? undefined,
          limit: PAGE_SIZE,
          category: category === "all" ? undefined : category,
          q: debouncedSearch.length > 0 ? debouncedSearch : undefined,
        }),
      initialPageParam: null as string | null,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    });

  const communities = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="relative max-w-sm">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search communities or tags…"
          aria-label="Search communities"
          className="pl-10"
        />
      </div>

      {categories.length > 0 && (
        <CommunityFilters
          categories={categories}
          value={category}
          onChange={setCategory}
        />
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : communities.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">
            No communities match your search.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {communities.map((community) => (
            <CommunityCard key={community.id} community={community} />
          ))}
        </div>
      )}

      {hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
