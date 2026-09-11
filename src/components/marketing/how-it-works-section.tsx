"use client";

import { FolderPlus, Radio, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { SectionHeading } from "@/components/layout/section-heading";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";

interface Step {
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * The three steps, in order.
 *
 * Numbered because this genuinely *is* a sequence — you cannot post an update
 * before there is a project to post it against, and nobody follows work that
 * has not been shown yet. Numbering a set of unordered features would be
 * decoration; here the order is the point, and the connecting rule between
 * markers is drawing something true.
 *
 * The copy matches what the product actually does. "A title is all you need"
 * is the literal contract of the create-project form, which requires exactly
 * one field.
 */
const STEPS: Step[] = [
  {
    icon: FolderPlus,
    title: "Start the project",
    description:
      "A title is all you need. The roadmap, tech stack, milestones, and team can come later — or never, if that is not how you work.",
  },
  {
    icon: Radio,
    title: "Ship in the open",
    description:
      "Post updates as you go. Progress, dead ends, demos, the commit that finally fixed it. Every update becomes part of the build history on your profile.",
  },
  {
    icon: Users,
    title: "Find your people",
    description:
      "Followers, feedback, and collaborators arrive because of the work, not a pitch. Open a role when you need one and let the right people find you.",
  },
];

export function HowItWorksSection() {
  return (
    <Section id="how-it-works">
      <Container>
        <SectionHeading
          eyebrow="How it works"
          title="Three steps, and the third one is the point"
          lede="The first two take an afternoon. The third is what the platform is for."
        />

        <ol className="relative mt-16 grid gap-12 md:grid-cols-3 md:gap-8">
          {/* The rule that makes the sequence visible. Sits behind the markers,
              spans only the gaps between them, and exists on wide screens where
              the steps read left-to-right — stacked on mobile the vertical
              order already says it. */}
          <div
            aria-hidden="true"
            className="via-border absolute top-6 right-0 left-0 hidden h-px bg-gradient-to-r from-transparent to-transparent md:block"
          />

          {STEPS.map((step, index) => (
            <RevealOnScroll key={step.title} delay={index * 0.1}>
              <li className="relative flex flex-col items-center text-center md:items-start md:text-left">
                <span className="raised text-primary relative z-10 flex size-12 items-center justify-center rounded-full">
                  <step.icon className="size-5" />
                </span>

                <div className="mt-5 flex items-center gap-2">
                  <span className="text-muted-foreground/60 font-display text-sm tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-display text-lg font-semibold tracking-tight">
                    {step.title}
                  </h3>
                </div>

                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  {step.description}
                </p>
              </li>
            </RevealOnScroll>
          ))}
        </ol>
      </Container>
    </Section>
  );
}
