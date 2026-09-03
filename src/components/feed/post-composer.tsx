"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { apiErrorMessage } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { createPost, type FeedPost } from "@/lib/services/feed-service";
import { getCurrentUser } from "@/lib/services/user-service";
import { useToast } from "@/hooks/use-toast";
import type { FeedFilter, Paginated, PostType } from "@/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const POST_TYPE_OPTIONS: { value: PostType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "update", label: "Update" },
  { value: "milestone", label: "Milestone" },
];

/**
 * Prepends the newly created post into the active filter's cached first page.
 *
 * Still a cache write rather than a refetch, for the reason it always was: a
 * brand-new post will not appear at the top of a `trending` sort, and dropping
 * it would look like the post failed. The difference now is that the object
 * being prepended is the server's own response — real id, real timestamp, real
 * author — so there is nothing to reconcile later.
 */
export function PostComposer({ activeFilter }: { activeFilter: FeedFilter }) {
  const toast = useToast((state) => state.toast);
  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery({
    queryKey: queryKeys.currentUser,
    queryFn: getCurrentUser,
  });
  const [content, setContent] = useState("");
  const [type, setType] = useState<PostType>("text");

  const publish = useMutation({
    mutationFn: (draft: { content: string; type: PostType }) => createPost(draft),
    onSuccess: (post) => {
      queryClient.setQueryData<InfiniteData<Paginated<FeedPost>>>(
        queryKeys.feed(activeFilter),
        (data) => {
          if (!data || data.pages.length === 0) return data;
          const [firstPage, ...rest] = data.pages;
          return {
            ...data,
            pages: [{ ...firstPage, items: [post, ...firstPage.items] }, ...rest],
          };
        },
      );
      setContent("");
      setType("text");
    },
    onError: (error) => {
      toast({
        variant: "danger",
        title: "Could not publish that post",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    },
  });

  function handleSubmit() {
    const trimmed = content.trim();
    if (!trimmed) return;
    publish.mutate({ content: trimmed, type });
  }

  if (!currentUser) return null;

  return (
    <Card className="p-4">
      <div className="flex gap-3">
        <Avatar className="shrink-0">
          <AvatarImage src={currentUser.avatarUrl ?? undefined} alt="" />
          <AvatarFallback>{currentUser.displayName.charAt(0)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Share a build update…"
            rows={2}
            aria-label="Write a post"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <Select value={type} onValueChange={(value) => setType(value as PostType)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POST_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleSubmit}
              disabled={!content.trim() || publish.isPending}
            >
              {publish.isPending && <Loader2 className="size-4 animate-spin" />}
              Post
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
