"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Users } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { CommunitySummary } from "@/lib/services/community-service";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/**
 * Typed against the discovery projection, not the full `Community`.
 *
 * The list endpoint deliberately serves a lighter shape — no rules, events,
 * pins, or moderator list, because a paginated grid renders none of them and
 * each is a per-community sub-query.
 */
export function CommunityCard({ community }: { community: CommunitySummary }) {
  return (
    <Link href={routes.community(community.slug)}>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="h-full"
      >
        <Card className="hover:border-border-strong flex h-full flex-col p-5 transition-[border-color,box-shadow] hover:shadow-[var(--shadow-floating)]">
          <div className="flex items-center gap-3">
            <Avatar className="size-11">
              <AvatarFallback className="font-display">
                {community.name.charAt(0)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{community.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {community.category}
              </p>
            </div>
          </div>
          <p className="text-muted-foreground mt-3 line-clamp-2 flex-1 text-sm">
            {community.description}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {community.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-[10px]">
                {tag}
              </Badge>
            ))}
          </div>
          <div className="border-border mt-4 flex items-center gap-1.5 border-t pt-3 text-xs">
            <Users className="text-muted-foreground size-3.5" />
            <span className="text-muted-foreground">
              {formatCompactNumber(community.memberCount)} members
            </span>
          </div>
        </Card>
      </motion.div>
    </Link>
  );
}
