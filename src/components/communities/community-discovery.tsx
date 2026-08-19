"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { getCommunities } from "@/lib/services/community-service";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CommunityCard } from "@/components/communities/community-card";
import { CommunityFilters } from "@/components/communities/community-filters";

/** PRD.md §4.6 "Categories" — a real client-side filter (unlike the
 * topbar's visual-only search) since the whole community list is small
 * enough to filter in the browser. */
export function CommunityDiscovery() {
  const { data: communities, isLoading } = useQuery({
    queryKey: ["communities"],
    queryFn: getCommunities,
  });
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");

  const categories = useMemo(
    () =>
      Array.from(
        new Set((communities ?? []).map((community) => community.category)),
      ).sort(),
    [communities],
  );

  const filtered = useMemo(() => {
    if (!communities) return [];
    const query = search.trim().toLowerCase();
    return communities.filter((community) => {
      const matchesCategory = category === "all" || community.category === category;
      const matchesSearch =
        !query ||
        community.name.toLowerCase().includes(query) ||
        community.tags.some((tag) => tag.toLowerCase().includes(query));
      return matchesCategory && matchesSearch;
    });
  }, [communities, category, search]);

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

      {communities && (
        <CommunityFilters
          categories={categories}
          value={category}
          onChange={setCategory}
        />
      )}

      {isLoading || !communities ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-muted-foreground text-sm">
            No communities match your search.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((community) => (
            <CommunityCard key={community.id} community={community} />
          ))}
        </div>
      )}
    </div>
  );
}
