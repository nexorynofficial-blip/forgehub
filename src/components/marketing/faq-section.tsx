"use client";

import { useState } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { SectionHeading } from "@/components/layout/section-heading";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";

/**
 * The questions a visitor actually stops on.
 *
 * Written to answer objections rather than to restate features — a FAQ that
 * asks "What is ForgeHub?" is a second hero, and nobody reads it. Each answer
 * here is something the product genuinely does today; where the honest answer
 * is "not yet", it says so, because a landing page that overpromises is found
 * out on day one of the trial.
 */

interface QA {
  question: string;
  answer: string;
}

const FAQS: QA[] = [
  {
    question: "Do I have to share work that isn't finished?",
    answer:
      "No. Projects can be public, unlisted, or private, and you choose per project. Plenty of people keep something private until the first demo works, then open it up. Building in public is the default here, not the requirement.",
  },
  {
    question: "Is this just another portfolio site?",
    answer:
      "A portfolio shows finished work. ForgeHub is built around work in progress — roadmaps, milestones, updates posted as you go — so the record of how you got there is the thing people follow. The finished portfolio falls out of that as a side effect.",
  },
  {
    question: "What does it cost?",
    answer:
      "Nothing while ForgeHub is in beta, and no card is required to sign up. There is no paid tier yet. When one exists it will be announced well ahead of time, and what you have already posted stays yours either way.",
  },
  {
    question: "Can I bring my team?",
    answer:
      "Yes. Projects have members with roles, so co-founders and collaborators can post updates and manage the roadmap alongside you. You can also open a role on a project to recruit someone you have not met yet.",
  },
  {
    question: "How do I sign in?",
    answer:
      "Email and password, with optional two-factor authentication, or a Google account. Two-factor applies to every sign-in method once you turn it on — signing in with Google does not skip it.",
  },
  {
    question: "What happens to my projects if I leave?",
    answer:
      "They are yours. Closing an account removes your profile and projects from public view. Nothing you post is used to train anything or sold to anyone.",
  },
];

function FaqItem({
  item,
  isOpen,
  onToggle,
}: {
  item: QA;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-border border-b">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="focus-visible:ring-ring group flex w-full items-start justify-between gap-6 rounded-sm py-5 text-left focus-visible:ring-2 focus-visible:outline-none"
        >
          <span className="group-hover:text-primary font-display text-base font-medium transition-colors sm:text-lg">
            {item.question}
          </span>
          <Plus
            aria-hidden="true"
            className={cn(
              "text-muted-foreground mt-1 size-5 shrink-0 transition-transform duration-300",
              isOpen && "rotate-45",
            )}
          />
        </button>
      </h3>

      {/* Grid-rows rather than max-height: the row collapses to the content's
          real height, so a long answer is never clipped and a short one leaves
          no dead space — neither of which a guessed max-height gets right. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <p className="text-muted-foreground pr-12 pb-5 text-sm leading-relaxed">
            {item.answer}
          </p>
        </div>
      </div>
    </div>
  );
}

export function FaqSection() {
  // One open at a time. The list is short enough that an accordion keeps the
  // whole set scannable, which is the reason to collapse them at all.
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <Section id="faq">
      <Container>
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
          <SectionHeading
            eyebrow="Questions"
            title="Before you sign up"
            lede="The things people ask before they post their first update."
            align="start"
            className="lg:sticky lg:top-28"
          />

          <RevealOnScroll delay={0.1}>
            <div className="border-border border-t">
              {FAQS.map((item, index) => (
                <FaqItem
                  key={item.question}
                  item={item}
                  isOpen={openIndex === index}
                  onToggle={() => setOpenIndex(openIndex === index ? null : index)}
                />
              ))}
            </div>
          </RevealOnScroll>
        </div>
      </Container>
    </Section>
  );
}
