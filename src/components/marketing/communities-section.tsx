"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Users2 } from "lucide-react";

import { formatCompactNumber } from "@/lib/format";
import { routes } from "@/lib/routes";
import { getFeaturedCommunities } from "@/lib/services/marketing-service";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AmbientGlow } from "@/components/marketing/ambient-glow";
import { LiveActivityFeed } from "@/components/marketing/live-activity-feed";

export function CommunitiesSection() {
  const { data: communities, isLoading } = useQuery({
    queryKey: ["featuredCommunities"],
    queryFn: getFeaturedCommunities,
  });

  return (
    <Section id="communities">
      <AmbientGlow variant="accent" className="top-1/2 -left-48 -translate-y-1/2" />

      <Container className="grid grid-cols-1 items-start gap-12 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <RevealOnScroll blur>
            <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Find your community
            </h2>
            <p className="text-muted-foreground mt-4 max-w-xl text-lg">
              Join a community built around what you&apos;re making, not just who you
              follow.
            </p>
          </RevealOnScroll>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {isLoading || !communities
              ? Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-24" />
                ))
              : communities.map((community, index) => (
                  <RevealOnScroll key={community.id} delay={index * 0.05}>
                    <Link href={routes.communities}>
                      <motion.div
                        whileHover={{ y: -4 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                        className="h-full"
                      >
                        <Card className="hover:border-border-strong h-full transition-[border-color,box-shadow] hover:shadow-[var(--shadow-floating)]">
                          <CardContent className="flex items-start gap-3 pt-6">
                            <span className="bg-secondary/15 text-secondary flex size-10 shrink-0 items-center justify-center rounded-md">
                              <Users2 className="size-5" />
                            </span>
                            <div>
                              <p className="text-foreground font-medium">
                                {community.name}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                {formatCompactNumber(community.memberCount)} members
                              </p>
                              <Badge variant="outline" className="mt-2">
                                {community.category}
                              </Badge>
                            </div>
                          </CardContent>
                        </Card>
                      </motion.div>
                    </Link>
                  </RevealOnScroll>
                ))}
          </div>
        </div>

        <RevealOnScroll delay={0.1}>
          <LiveActivityFeed />
        </RevealOnScroll>
      </Container>
    </Section>
  );
}
