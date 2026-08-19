"use client";

import Link from "next/link";

import { routes } from "@/lib/routes";
import type { PostAuthor } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

/** UI_UX.md §10 "Hover Preview" — hovering an author surfaces a mini profile
 * card built from the data already on the post (no extra round trip). */
export function AuthorHoverCard({
  author,
  children,
}: {
  author: PostAuthor;
  children: React.ReactNode;
}) {
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <Link
          href={routes.profile(author.username)}
          className="focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
        >
          {children}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarImage src={author.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{author.displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{author.displayName}</p>
            <p className="text-muted-foreground truncate text-xs">
              @{author.username} · {author.builderRank}
            </p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
