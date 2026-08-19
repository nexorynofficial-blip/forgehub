"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function CommunityFilters({
  categories,
  value,
  onChange,
}: {
  categories: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="overflow-x-auto pb-1">
      <Tabs value={value} onValueChange={onChange}>
        <TabsList className="w-max">
          <TabsTrigger value="all">All</TabsTrigger>
          {categories.map((category) => (
            <TabsTrigger key={category} value={category}>
              {category}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
