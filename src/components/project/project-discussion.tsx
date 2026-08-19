"use client";

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { addProjectComment, getProjectDiscussion } from "@/lib/services/project-service";
import { getCurrentUser } from "@/lib/services/user-service";
import type { PostAuthor, ProjectDiscussionComment } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/** UI_UX.md §9 "Discussion" + "Comments" — one consolidated thread, see
 * docs/ASSUMPTIONS.md (Phase 07) and types/project-page.ts. */
export function ProjectDiscussion({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { data: comments, isLoading } = useQuery({
    queryKey: ["projectDiscussion", projectId],
    queryFn: () => getProjectDiscussion(projectId),
  });
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !currentUser) return;

    setIsSubmitting(true);
    const author: PostAuthor = {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      avatarUrl: currentUser.avatarUrl,
      builderRank: currentUser.builderRank,
    };
    const comment = await addProjectComment(projectId, content, author);
    queryClient.setQueryData<ProjectDiscussionComment[]>(
      ["projectDiscussion", projectId],
      (prev) => [...(prev ?? []), comment],
    );
    setDraft("");
    setIsSubmitting(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discussion</CardTitle>
      </CardHeader>
      <CardContent>
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
              <li key={comment.id} className="flex gap-2.5">
                <Avatar className="size-8 shrink-0">
                  <AvatarImage src={comment.author.avatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="text-xs">
                    {comment.author.displayName.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div className="bg-surface min-w-0 flex-1 rounded-md px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <p className="text-sm font-medium">{comment.author.displayName}</p>
                    <time className="text-muted-foreground text-[11px]">
                      {formatRelativeTime(comment.createdAt)}
                    </time>
                  </div>
                  <p className="text-sm">{comment.content}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            No comments yet — start the discussion.
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-4 flex items-center gap-2">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask a question or leave feedback…"
            aria-label="Write a comment"
            disabled={isSubmitting}
          />
          <Button
            type="submit"
            size="icon"
            variant="secondary"
            disabled={!draft.trim() || isSubmitting}
            aria-label="Post comment"
          >
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
