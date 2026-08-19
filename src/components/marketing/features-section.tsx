"use client";

import { motion } from "framer-motion";
import {
  Award,
  Compass,
  Megaphone,
  MessageSquare,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AmbientGlow } from "@/components/marketing/ambient-glow";

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** PRD.md §3 Main Goals, condensed into landing-page copy. */
const FEATURES: Feature[] = [
  {
    icon: Megaphone,
    title: "Build in the open",
    description:
      "Post progress updates, milestones, and demos as you go. Your build history becomes your portfolio.",
  },
  {
    icon: Users,
    title: "Recruit collaborators",
    description:
      "Open roles on your project and let the right co-founders, engineers, and designers find you.",
  },
  {
    icon: MessageSquare,
    title: "Get real feedback",
    description:
      "Ship early and hear from people who actually use products like yours — not just your friends.",
  },
  {
    icon: TrendingUp,
    title: "Track your progress",
    description:
      "Roadmaps, milestones, and a contribution graph that shows the work behind the launch.",
  },
  {
    icon: Compass,
    title: "Discover what's next",
    description:
      "A feed tuned to the tools, categories, and people you care about — not vanity metrics.",
  },
  {
    icon: Award,
    title: "Earn your reputation",
    description:
      "Builder rank, streaks, and community score built from what you actually ship.",
  },
];

export function FeaturesSection() {
  return (
    <Section id="features">
      <AmbientGlow variant="secondary" className="-top-32 -right-40" />

      <Container>
        <RevealOnScroll blur className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything you need to build in public
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            One platform for the whole loop — from first commit to launch day.
          </p>
        </RevealOnScroll>

        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, index) => (
            <RevealOnScroll key={feature.title} delay={index * 0.06}>
              <motion.div
                whileHover={{ scale: 1.015 }}
                transition={{ type: "spring", stiffness: 400, damping: 25 }}
                className="h-full"
              >
                <Card className="hover:border-primary/40 h-full transition-[border-color,box-shadow] hover:shadow-[var(--shadow-glow-primary)]">
                  <CardHeader>
                    <span className="bg-primary/15 text-primary mb-2 flex size-10 items-center justify-center rounded-md">
                      <feature.icon className="size-5" />
                    </span>
                    <CardTitle>{feature.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            </RevealOnScroll>
          ))}
        </div>
      </Container>
    </Section>
  );
}
