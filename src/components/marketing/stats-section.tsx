"use client";

import { useQuery } from "@tanstack/react-query";

import { formatCompactNumber } from "@/lib/format";
import { getPlatformStats } from "@/lib/services/marketing-service";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { AmbientGlow } from "@/components/marketing/ambient-glow";
import { AnimatedCounter } from "@/components/motion/animated-counter";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { Skeleton } from "@/components/ui/skeleton";

export function StatsSection() {
  const { data: stats, isLoading } = useQuery({
    queryKey: ["platformStats"],
    queryFn: getPlatformStats,
  });

  const items = stats
    ? [
        { label: "Builders", value: stats.builderCount },
        { label: "Projects shipped", value: stats.projectCount },
        { label: "Collaborations formed", value: stats.collaborationCount },
        { label: "Countries", value: stats.countryCount },
      ]
    : [];

  return (
    <Section className="border-border border-y py-16 sm:py-20">
      <AmbientGlow
        variant="secondary"
        className="top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-60"
      />

      <Container>
        <RevealOnScroll className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {isLoading || !stats
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2 text-center">
                  <Skeleton className="h-10 w-20" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))
            : items.map((item) => (
                <div
                  key={item.label}
                  className="flex flex-col items-center gap-1 text-center"
                >
                  <AnimatedCounter
                    value={item.value}
                    format={(n) => formatCompactNumber(Math.round(n))}
                    className="font-display gradient-text-brand text-4xl font-semibold tracking-tight sm:text-5xl"
                  />
                  <p className="text-muted-foreground text-sm">{item.label}</p>
                </div>
              ))}
        </RevealOnScroll>
      </Container>
    </Section>
  );
}
