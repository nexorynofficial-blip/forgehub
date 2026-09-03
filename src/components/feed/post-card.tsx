"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Bookmark, Heart, MessageCircle } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import {
  bookmarkPost,
  likePost,
  unbookmarkPost,
  unlikePost,
} from "@/lib/services/feed-service";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { PostType, PostWithAuthor } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfettiBurst } from "@/components/motion/confetti-burst";
import { AuthorHoverCard } from "@/components/feed/author-hover-card";
import { CommentSection } from "@/components/feed/comment-section";
import { PostTypeContent } from "@/components/feed/post-type-content";

const KIND_BADGE: Partial<
  Record<PostType, { label: string; variant: BadgeProps["variant"] }>
> = {
  milestone: { label: "Milestone", variant: "success" },
  update: { label: "Update", variant: "secondary" },
  announcement: { label: "Announcement", variant: "primary" },
};

/**
 * UI_UX.md §10 "Animated Reactions" — now persisted.
 *
 * The like stays optimistic so the heart still moves under the finger, but the
 * server gets the last word: its response carries the authoritative
 * `likesCount`, and a failure rolls the button back rather than leaving the
 * card claiming a like that was never recorded.
 */
export function PostCard({
  post,
  interactive = true,
}: {
  post: PostWithAuthor;
  /**
   * Whether the engagement controls act.
   *
   * False on the public landing page's product preview, where the viewer is
   * anonymous: every like or bookmark there would 401, so the row renders as
   * static counters rather than buttons that can only fail.
   */
  interactive?: boolean;
}) {
  const toast = useToast((state) => state.toast);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.likesCount);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  const badge = KIND_BADGE[post.type];

  const like = useMutation({
    mutationFn: (next: boolean) => (next ? likePost(post.id) : unlikePost(post.id)),
    onSuccess: (result) => {
      setIsLiked(result.liked);
      setLikeCount(result.likesCount);
    },
    onError: (error, next) => {
      setIsLiked(!next);
      setLikeCount((prev) => prev + (next ? -1 : 1));
      toast({
        variant: "danger",
        title: "Could not save that",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  const bookmark = useMutation({
    mutationFn: (next: boolean) =>
      next ? bookmarkPost(post.id) : unbookmarkPost(post.id),
    onSuccess: (result) => setIsBookmarked(result.bookmarked),
    onError: (error, next) => {
      setIsBookmarked(!next);
      toast({
        variant: "danger",
        title: "Could not save that",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  function handleLike() {
    const nextLiked = !isLiked;
    setIsLiked(nextLiked);
    setLikeCount((prev) => prev + (nextLiked ? 1 : -1));
    if (nextLiked) setBurstKey((prev) => prev + 1);
    like.mutate(nextLiked);
  }

  function handleBookmark() {
    const next = !isBookmarked;
    setIsBookmarked(next);
    bookmark.mutate(next);
  }

  return (
    <Card className="p-5 transition-shadow hover:shadow-[var(--shadow-floating)]">
      <div className="flex items-start gap-3">
        <AuthorHoverCard author={post.author}>
          <Avatar>
            <AvatarImage src={post.author.avatarUrl ?? undefined} alt="" />
            <AvatarFallback>{post.author.displayName.charAt(0)}</AvatarFallback>
          </Avatar>
        </AuthorHoverCard>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <AuthorHoverCard author={post.author}>
              <span className="hover:text-primary text-sm font-medium transition-colors">
                {post.author.displayName}
              </span>
            </AuthorHoverCard>
            <span className="text-muted-foreground text-xs">@{post.author.username}</span>
            <span className="text-muted-foreground text-xs">·</span>
            <time className="text-muted-foreground text-xs">
              {formatRelativeTime(post.createdAt)}
            </time>
            {badge && (
              <Badge variant={badge.variant} className="ml-auto">
                {badge.label}
              </Badge>
            )}
          </div>

          <p className="mt-2 text-sm leading-relaxed whitespace-pre-line">
            {post.content}
          </p>
          <PostTypeContent post={post} />

          {!interactive ? (
            <div className="text-muted-foreground mt-4 flex items-center gap-4 px-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Heart className="size-4" />
                {formatCompactNumber(likeCount)}
              </span>
              <span className="flex items-center gap-1.5">
                <MessageCircle className="size-4" />
                {formatCompactNumber(post.commentsCount)}
              </span>
            </div>
          ) : (
            <div className="mt-4 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLike}
                aria-pressed={isLiked}
                aria-label={isLiked ? "Unlike" : "Like"}
                className={cn("relative gap-1.5 px-2", isLiked && "text-danger")}
              >
                <motion.span
                  animate={isLiked ? { scale: [1, 1.35, 1] } : { scale: 1 }}
                  transition={{ duration: 0.3 }}
                  className="relative inline-flex"
                >
                  <Heart className={cn("size-4", isLiked && "fill-current")} />
                  {burstKey > 0 && <ConfettiBurst key={burstKey} count={7} />}
                </motion.span>
                {formatCompactNumber(likeCount)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowComments((prev) => !prev)}
                aria-expanded={showComments}
                aria-label={showComments ? "Hide comments" : "Show comments"}
                className="gap-1.5 px-2"
              >
                <MessageCircle className="size-4" />
                {formatCompactNumber(post.commentsCount)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBookmark}
                disabled={bookmark.isPending}
                aria-pressed={isBookmarked}
                aria-label={isBookmarked ? "Remove bookmark" : "Bookmark"}
                className={cn("gap-1.5 px-2", isBookmarked && "text-primary")}
              >
                <Bookmark className={cn("size-4", isBookmarked && "fill-current")} />
              </Button>
            </div>
          )}

          {interactive && showComments && <CommentSection postId={post.id} />}
        </div>
      </div>
    </Card>
  );
}
