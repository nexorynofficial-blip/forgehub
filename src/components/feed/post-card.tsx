"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Heart, MessageCircle } from "lucide-react";

import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
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

/** UI_UX.md §10 "Animated Reactions" (like) — see docs/ASSUMPTIONS.md for
 * why likes/comments are optimistic-local rather than persisted. */
export function PostCard({ post }: { post: PostWithAuthor }) {
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.likesCount);
  const [showComments, setShowComments] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  const badge = KIND_BADGE[post.type];

  function handleLike() {
    const nextLiked = !isLiked;
    setIsLiked(nextLiked);
    setLikeCount((prev) => prev + (isLiked ? -1 : 1));
    if (nextLiked) setBurstKey((prev) => prev + 1);
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
          </div>

          {showComments && <CommentSection postId={post.id} />}
        </div>
      </div>
    </Card>
  );
}
