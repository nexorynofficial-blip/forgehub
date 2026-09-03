"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import {
  addComment,
  getCommentsForPost,
  type CommentPage,
  type FeedComment,
} from "@/lib/services/feed-service";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * One comment row.
 *
 * A soft-deleted comment that still has live replies comes back as a
 * tombstone: `isDeleted: true` and **no author at all**. It is still rendered
 * so its replies do not become unreachable, but it discloses nothing about who
 * wrote it — which is the whole point of the tombstone.
 */
function CommentRow({ comment }: { comment: FeedComment }) {
  if (comment.isDeleted || !comment.author) {
    return (
      <li className="flex gap-2.5">
        <div className="bg-muted size-8 shrink-0 rounded-full" aria-hidden="true" />
        <div className="bg-surface text-muted-foreground min-w-0 flex-1 rounded-md px-3 py-2 text-sm italic">
          This comment was deleted.
        </div>
      </li>
    );
  }

  const { author } = comment;

  return (
    <li className="flex gap-2.5">
      <Avatar className="size-8 shrink-0">
        <AvatarImage src={author.avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="text-xs">
          {author.displayName.charAt(0)}
        </AvatarFallback>
      </Avatar>
      <div className="bg-surface min-w-0 flex-1 rounded-md px-3 py-2">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium">{author.displayName}</p>
          <time className="text-muted-foreground text-[11px]">
            {formatRelativeTime(comment.createdAt)}
          </time>
        </div>
        <p className="text-sm">{comment.content}</p>
      </div>
    </li>
  );
}

/** UI_UX.md §10 "Live Comments" — real `POST /posts/{id}/comments`. */
export function CommentSection({ postId }: { postId: string }) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.postComments(postId),
    queryFn: () => getCommentsForPost(postId),
  });

  const comments = data?.comments;

  /**
   * The new comment is appended from the server's own response, so it carries
   * the real id and timestamp. The author is not assembled here at all — the
   * backend derives it from the access token, which is the only source that
   * cannot be spoofed.
   */
  const post = useMutation({
    mutationFn: (content: string) => addComment(postId, content),
    onSuccess: (comment) => {
      queryClient.setQueryData<CommentPage>(queryKeys.postComments(postId), (prev) =>
        prev
          ? { ...prev, comments: [...prev.comments, comment] }
          : { comments: [comment], nextCursor: null },
      );
      setDraft("");
    },
    onError: (error) => {
      toast({
        variant: "danger",
        title: "Could not post that comment",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    post.mutate(content);
  }

  return (
    <div className="border-border mt-4 border-t pt-4">
      {isLoading || !comments ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <Skeleton className="h-8 flex-1" />
            </div>
          ))}
        </div>
      ) : comments.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No comments yet — be the first.</p>
      )}

      <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a comment…"
          aria-label="Write a comment"
          disabled={post.isPending}
        />
        <Button
          type="submit"
          size="icon"
          variant="secondary"
          disabled={!draft.trim() || post.isPending}
          aria-label="Post comment"
        >
          {post.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
