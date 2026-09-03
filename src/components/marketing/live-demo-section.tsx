"use client";

import { MessageCircle, Rss } from "lucide-react";

import { mockMessagesByConversationId } from "@/lib/mock/messages";
import { DANA, resolvePersonById } from "@/lib/mock/people";
import { mockPosts } from "@/lib/mock/posts";
import type { MessageWithSender } from "@/types";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { AmbientGlow } from "@/components/marketing/ambient-glow";
import { FadeIn } from "@/components/motion/fade-in";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { PostCard } from "@/components/feed/post-card";
import { MessageBubble } from "@/components/messages/message-bubble";
import { TypingIndicator } from "@/components/messages/typing-indicator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * **Static marketing content.**
 *
 * This section sits on the public landing page, where the visitor is
 * anonymous. It therefore renders the real components against *sample* data
 * and makes no API call at all: `GET /messages/...` requires a session and
 * would 401 for every visitor, and reading a real conversation to advertise
 * the product would be showing one user's correspondence to strangers.
 *
 * The components are genuine — this is the same `PostCard` and `MessageBubble`
 * the app uses — but they run in non-interactive mode, because a Like that can
 * only ever fail is worse than a Like that is plainly a picture.
 */
const DEMO_POST_IDS = ["pst_004", "pst_001"];
const DEMO_CONVERSATION_ID = "cvo_001";

function FeedDemo() {
  const posts = DEMO_POST_IDS.map((id) => mockPosts.find((p) => p.id === id)).filter(
    (post) => post != null,
  );

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {posts.map((post) => (
        <PostCard key={post.id} post={post} interactive={false} />
      ))}
    </div>
  );
}

function MessagesDemo() {
  const messages: MessageWithSender[] = (
    mockMessagesByConversationId[DEMO_CONVERSATION_ID] ?? []
  )
    .slice(-4)
    .map((message) => {
      const sender = resolvePersonById(message.senderId);
      return sender ? { ...message, sender } : null;
    })
    .filter((message): message is MessageWithSender => message !== null);

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          isOwn={message.senderId !== DANA.id}
          showSender={false}
          showStatus={false}
          isSeen={false}
        />
      ))}
      <TypingIndicator usernames={[DANA.displayName]} />
    </div>
  );
}

/** "Interactive Live Product Demo" — the real Feed and Messages UI running
 * inside a device-frame mockup, not screenshots or a video. Likes, poll
 * votes, and comment expansion all genuinely work here because they're the
 * same `PostCard`/`MessageBubble` components (and the same mock data) the
 * rest of the app uses — nothing was built twice. */
export function LiveDemoSection() {
  return (
    <Section id="demo">
      <AmbientGlow variant="primary" className="top-0 left-1/2 -translate-x-1/2" />

      <Container>
        <RevealOnScroll blur className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            See ForgeHub in action
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            This isn&apos;t a screenshot — it&apos;s the real interface, running on sample
            data. Switch tabs to look around.
          </p>
        </RevealOnScroll>

        <RevealOnScroll delay={0.1} className="mx-auto mt-12 max-w-xl">
          <div className="glass-strong overflow-hidden rounded-lg shadow-[var(--shadow-floating)]">
            <Tabs defaultValue="feed">
              <div className="border-border flex items-center justify-between border-b px-4 py-3 sm:px-6">
                <div aria-hidden="true" className="flex gap-1.5">
                  <span className="bg-danger/60 size-2.5 rounded-full" />
                  <span className="bg-accent/60 size-2.5 rounded-full" />
                  <span className="bg-success/60 size-2.5 rounded-full" />
                </div>
                <TabsList className="h-9 p-0.5">
                  <TabsTrigger value="feed" className="gap-1.5 px-3 py-1 text-xs">
                    <Rss className="size-3.5" />
                    Feed
                  </TabsTrigger>
                  <TabsTrigger value="messages" className="gap-1.5 px-3 py-1 text-xs">
                    <MessageCircle className="size-3.5" />
                    Messages
                  </TabsTrigger>
                </TabsList>
                {/* Balances the traffic-light dots so the tab pill stays
                 * visually centered in the window chrome. */}
                <div aria-hidden="true" className="w-[52px]" />
              </div>

              {/* `forceMount` keeps both panels mounted (hidden via
               * `data-[state=inactive]:hidden`) instead of Radix's default
               * unmount-on-switch — otherwise a visitor who likes a post or
               * votes, peeks at Messages, and switches back would find
               * their interaction silently reset, which would undercut the
               * section's whole "this is real, not a mockup" point. */}
              <TabsContent
                value="feed"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <FadeIn>
                  <FeedDemo />
                </FadeIn>
              </TabsContent>
              <TabsContent
                value="messages"
                forceMount
                className="mt-0 data-[state=inactive]:hidden"
              >
                <FadeIn>
                  <MessagesDemo />
                </FadeIn>
              </TabsContent>
            </Tabs>
          </div>
        </RevealOnScroll>
      </Container>
    </Section>
  );
}
