import type { Metadata } from "next";

import { FadeIn } from "@/components/motion/fade-in";
import { FeedList } from "@/components/feed/feed-list";

export const metadata: Metadata = { title: "Feed" };

export default function FeedPage() {
  return (
    <div className="mx-auto max-w-2xl pt-8 pb-8">
      <FadeIn>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Feed</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          What builders are shipping right now.
        </p>
      </FadeIn>
      <FadeIn delay={0.05} className="mt-6">
        <FeedList />
      </FadeIn>
    </div>
  );
}
