"use client";

import { useQuery } from "@tanstack/react-query";

import { formatRelativeTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { getProjectUpdates } from "@/lib/services/project-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** UI_UX.md §9 "Updates" — the project's own changelog, distinct from Feed
 * milestone/announcement posts (those are social; these are the project's
 * record). See docs/ASSUMPTIONS.md (Phase 07). */
export function ProjectUpdates({ slug }: { slug: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.projectUpdates(slug),
    queryFn: () => getProjectUpdates(slug),
  });

  const updates = data?.updates;

  if (!isLoading && updates?.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Updates</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !updates ? (
          <div className="flex flex-col gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <Skeleton className="h-10 flex-1" />
              </div>
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {updates.map((update) => (
              <li key={update.id} className="flex gap-3">
                <Avatar className="size-9 shrink-0">
                  <AvatarImage src={update.author.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="text-xs">
                    {update.author.displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="bg-surface min-w-0 flex-1 rounded-md px-3 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-medium">{update.author.displayName}</p>
                    <time className="text-muted-foreground text-xs">
                      {formatRelativeTime(update.createdAt)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-sm">{update.content}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
