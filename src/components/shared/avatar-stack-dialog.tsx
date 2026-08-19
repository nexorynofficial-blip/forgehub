"use client";

import { formatCompactNumber } from "@/lib/format";
import type { FollowerPreview } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Overlapping avatar stack that opens a scrollable full-list dialog on
 * click. Originally built for Phase 05's `FollowersWidget`; extracted here
 * in Phase 08 so `CommunityMembers` doesn't duplicate the same pattern —
 * see docs/ASSUMPTIONS.md. */
export function AvatarStackDialog({
  people,
  totalCount,
  label,
  dialogTitle,
}: {
  people: FollowerPreview[];
  totalCount: number;
  label: string;
  dialogTitle: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="focus-visible:ring-ring flex items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:outline-none"
        >
          <div className="flex -space-x-2">
            {people.slice(0, 6).map((person) => (
              <Avatar key={person.id} className="border-card size-9 border-2">
                <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
                <AvatarFallback className="text-xs">
                  {person.displayName.charAt(0)}
                </AvatarFallback>
              </Avatar>
            ))}
          </div>
          <span className="text-sm">
            <strong className="font-semibold">{formatCompactNumber(totalCount)}</strong>{" "}
            <span className="text-muted-foreground">{label}</span>
          </span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-80">
          <ul className="flex flex-col gap-1">
            {people.map((person) => (
              <li key={person.id} className="flex items-center gap-3 rounded-md p-2">
                <Avatar className="size-9">
                  <AvatarImage src={person.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback>{person.displayName.charAt(0)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{person.displayName}</p>
                  <p className="text-muted-foreground truncate text-xs">
                    @{person.username}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
