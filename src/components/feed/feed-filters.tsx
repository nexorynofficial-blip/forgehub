"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FeedFilter } from "@/types";

const FILTERS: { value: FeedFilter; label: string }[] = [
  { value: "trending", label: "Trending" },
  { value: "latest", label: "Latest" },
  { value: "following", label: "Following" },
  { value: "recommended", label: "Recommended" },
  { value: "popular_today", label: "Popular Today" },
  { value: "ai_recommended", label: "AI Recommended" },
];

/** UI_UX.md §10 "Smart Filters" (PRD.md §4.4 Feed). */
export function FeedFilters({
  value,
  onChange,
}: {
  value: FeedFilter;
  onChange: (value: FeedFilter) => void;
}) {
  return (
    <div className="overflow-x-auto pb-1">
      <Tabs value={value} onValueChange={(next) => onChange(next as FeedFilter)}>
        <TabsList className="w-max">
          {FILTERS.map((filter) => (
            <TabsTrigger key={filter.value} value={filter.value}>
              {filter.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
