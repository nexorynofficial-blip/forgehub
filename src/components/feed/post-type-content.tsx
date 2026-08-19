import { ImageIcon, Play } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PostWithAuthor } from "@/types";
import { CodeBlock } from "@/components/feed/code-block";
import { PollVoter } from "@/components/feed/poll-voter";

/** Renders the type-specific body of a post (PRD.md §4.5). Text, markdown,
 * update, milestone, and announcement all render as plain content in the
 * card body itself (see PostCard) — nothing extra to add here. */
export function PostTypeContent({ post }: { post: PostWithAuthor }) {
  switch (post.type) {
    case "image":
      if (post.mediaUrls.length === 0) return null;
      return (
        <div
          className={cn(
            "mt-3 grid gap-1 overflow-hidden rounded-md",
            post.mediaUrls.length > 1 ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {post.mediaUrls.slice(0, 4).map((url, index) => (
            <div
              key={url + index}
              className="bg-muted flex aspect-video items-center justify-center"
            >
              <ImageIcon className="text-muted-foreground size-6" />
            </div>
          ))}
        </div>
      );
    case "video":
      return (
        <div className="bg-muted mt-3 flex aspect-video items-center justify-center rounded-md">
          <span className="bg-background/80 flex size-14 items-center justify-center rounded-full">
            <Play className="size-6 translate-x-0.5" />
          </span>
        </div>
      );
    case "code":
      return post.codeSnippet ? <CodeBlock snippet={post.codeSnippet} /> : null;
    case "poll":
      return post.poll ? <PollVoter poll={post.poll} /> : null;
    default:
      return null;
  }
}
