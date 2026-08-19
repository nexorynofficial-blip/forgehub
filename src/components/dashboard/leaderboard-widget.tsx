"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Crown, Medal } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { getLeaderboard } from "@/lib/services/dashboard-service";
import { getCurrentUser } from "@/lib/services/user-service";
import { cn } from "@/lib/utils";
import type { LeaderboardEntry } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Top-3 get a distinct medal treatment; everyone else is a plain rank
 * number — a leaderboard should read as a podium, not a spreadsheet. */
const MEDAL_STYLES: Record<number, { ring: string; badge: string }> = {
  1: { ring: "ring-accent/50", badge: "bg-accent/20 text-accent" },
  2: { ring: "ring-slate-300/40", badge: "bg-slate-300/15 text-slate-300" },
  3: { ring: "ring-orange-400/40", badge: "bg-orange-400/15 text-orange-400" },
};

function LeaderboardRow({
  entry,
  isCurrentUser,
}: {
  entry: LeaderboardEntry;
  isCurrentUser: boolean;
}) {
  const medal = MEDAL_STYLES[entry.rank];

  return (
    <motion.li
      whileHover={{ x: 3 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5",
        isCurrentUser && "bg-primary/10",
      )}
    >
      <span
        className={cn(
          "font-display flex size-6 shrink-0 items-center justify-center text-sm font-semibold",
          medal ? medal.badge : "text-muted-foreground",
          medal && "rounded-full",
        )}
      >
        {entry.rank === 1 ? (
          <Crown className="size-4" />
        ) : entry.rank <= 3 ? (
          <Medal className="size-3.5" />
        ) : (
          entry.rank
        )}
      </span>
      <Avatar className={cn("size-8", medal && `ring-2 ${medal.ring}`)}>
        <AvatarImage src={entry.avatarUrl ?? undefined} alt="" />
        <AvatarFallback>{entry.displayName.charAt(0)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.displayName}</p>
        <p className="text-muted-foreground truncate text-xs">{entry.builderRank}</p>
      </div>
      <span className="font-display text-sm font-semibold">
        {formatCompactNumber(entry.xp)}
      </span>
    </motion.li>
  );
}

/** UI_UX.md §7 "Leaderboard" (PRD.md §4.10 Reputation System). */
export function LeaderboardWidget() {
  const { data: leaderboard, isLoading } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: getLeaderboard,
  });
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Leaderboard</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !leaderboard ? (
          <ul className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2.5">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="flex flex-col gap-1">
            {leaderboard.map((entry) => (
              <LeaderboardRow
                key={entry.userId}
                entry={entry}
                isCurrentUser={entry.userId === currentUser?.id}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
