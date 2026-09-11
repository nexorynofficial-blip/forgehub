"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Heart, MessageCircle } from "lucide-react";

import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import { routes } from "@/lib/routes";
import { getFeedPage } from "@/lib/services/feed-service";
import type { FeedPost } from "@/lib/services/feed-service";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The last few posts from the feed the user actually has.
 *
 * Replaces the live-activity widget, which rendered "Activity feeds are not
 * available yet" in the dashboard's largest cell — there is no global activity
 * endpoint, and there was never going to be one on this schedule. `GET /feed`
 * exists, is already paginated, and answers the same question a person opens a
 * dashboard to ask: what happened while I was gone.
 *
 * Deliberately a preview, not a second feed. Four posts, truncated, with the
 * real page one click away — a dashboard that reproduces the feed gives the
 * user two of the same screen and a reason to ignore one of them.
 */

const PREVIEW_COUNT = 4;

function PostRow({ post }: { post: FeedPost }) {
  return (
    <Link
      href={routes.feed}
      className="hover:bg-muted focus-visible:ring-ring group flex gap-3 rounded-md p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      <Avatar className="size-8 shrink-0">
        <AvatarImage src={post.author.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="text-[11px]">
          {post.author.displayName.charAt(0)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="group-hover:text-primary truncate text-sm font-medium transition-colors">
            {post.author.displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs">
            {formatRelativeTime(post.createdAt)}
          </span>
        </div>

        {/* Two lines. A dashboard row is a pointer to the post, not the post. */}
        <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">{post.content}</p>

        <div className="text-muted-foreground mt-2 flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1">
            <Heart className="size-3.5" />
            {formatCompactNumber(post.likesCount)}
          </span>
          <span className="flex items-center gap-1">
            <MessageCircle className="size-3.5" />
            {formatCompactNumber(post.commentsCount)}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function FeedPreviewWidget() {
  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.feed("latest"), "dashboard-preview"],
    queryFn: () => getFeedPage({ filter: "latest", cursor: null, limit: PREVIEW_COUNT }),
  });

  const posts = data?.items ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Latest from your feed</CardTitle>
        <Button asChild variant="ghost" size="sm">
          <Link href={routes.feed}>
            Open feed
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-1">
        {isLoading ? (
          Array.from({ length: PREVIEW_COUNT }).map((_, i) => (
            <div key={i} className="flex gap-3 p-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-1.5 h-3 w-2/3" />
              </div>
            </div>
          ))
        ) : posts.length === 0 ? (
          <div className="flex flex-col items-start gap-3 p-3">
            <p className="text-muted-foreground text-sm">
              The feed is quiet. Post an update on what you are building and it lands
              here.
            </p>
            <Button asChild variant="primary" size="sm">
              <Link href={routes.feed}>
                Write a post
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        ) : (
          posts.map((post) => <PostRow key={post.id} post={post} />)
        )}
      </CardContent>
    </Card>
  );
}
