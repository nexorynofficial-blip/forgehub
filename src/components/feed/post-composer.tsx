"use client";

import { useState } from "react";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { createPost } from "@/lib/services/feed-service";
import { getCurrentUser } from "@/lib/services/user-service";
import type {
  FeedFilter,
  Paginated,
  PostAuthor,
  PostType,
  PostWithAuthor,
} from "@/types";
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

/** Prepends the new post directly into the active filter's cached first
 * page — no `createPost` mutation would otherwise show up in a sorted/
 * filtered feed without a full refetch. */
export function PostComposer({ activeFilter }: { activeFilter: FeedFilter }) {
  const queryClient = useQueryClient();
  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: getCurrentUser,
  });
  const [content, setContent] = useState("");
  const [type, setType] = useState<PostType>("text");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit() {
    const trimmed = content.trim();
    if (!trimmed || !currentUser) return;

    setIsSubmitting(true);
    const author: PostAuthor = {
      id: currentUser.id,
      username: currentUser.username,
      displayName: currentUser.displayName,
      avatarUrl: currentUser.avatarUrl,
      builderRank: currentUser.builderRank,
    };
    const post = await createPost({ content: trimmed, type, author });

    queryClient.setQueryData<InfiniteData<Paginated<PostWithAuthor>>>(
      ["feed", activeFilter],
      (data) => {
        if (!data) return data;
        const [firstPage, ...rest] = data.pages;
        return {
          ...data,
          pages: [{ ...firstPage, items: [post, ...firstPage.items] }, ...rest],
        };
      },
    );

    setContent("");
    setType("text");
    setIsSubmitting(false);
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
            <Button onClick={handleSubmit} disabled={!content.trim() || isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Post
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
