"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowRight, Play, Sparkles } from "lucide-react";

import { gsap, registerGsap } from "@/lib/gsap";
import { routes } from "@/lib/routes";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { Container } from "@/components/layout/container";
import { CursorGlow } from "@/components/motion/cursor-glow";
import { FadeIn } from "@/components/motion/fade-in";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { SceneCanvas } from "@/components/three";
import { Button } from "@/components/ui/button";
import { Aurora } from "@/components/marketing/aurora";
import { HeroPreview } from "@/components/marketing/hero-preview";
import { createHeroNetworkScene } from "@/components/marketing/hero-scene";

/**
 * The stacks the seeded projects are actually built with. A strip of real
 * tooling rather than logos of "trusted by" companies ForgeHub does not have —
 * the honest version of the same structural device, and the one that tells a
 * visitor whose work belongs here.
 */
const STACKS = [
  "TypeScript",
  "Next.js",
  "React",
  "PostgreSQL",
  "Tailwind",
  "Prisma",
  "WebGL",
];

/** UI_UX.md §5 "Parallax" — the bloom drifts and fades slower than the scroll
 * as the hero leaves the viewport (ARCHITECTURE.md §6: GSAP owns scroll-linked
 * work). See docs/ASSUMPTIONS.md (Phase 12). */
function useHeroParallax(
  sectionRef: React.RefObject<HTMLElement | null>,
  sceneRef: React.RefObject<HTMLDivElement | null>,
) {
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (prefersReducedMotion || !sectionRef.current || !sceneRef.current) return;

    registerGsap();
    const ctx = gsap.context(() => {
      gsap.to(sceneRef.current, {
        yPercent: 18,
        opacity: 0.25,
        ease: "none",
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "bottom top",
          scrub: true,
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, [prefersReducedMotion, sectionRef, sceneRef]);
}

export function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  useHeroParallax(sectionRef, sceneRef);

  /*
    No `min-h-screen` on the section below. The hero used to be forced to the
    full viewport height with `justify-center`, which left a 260px dead band
    above the badge and a 100px one under the stack strip — the section was
    tall because it was told to be, not because it held anything. It now sizes
    to its content, which includes the preview panel, and padding does the rest.
  */
  return (
    <section
      ref={sectionRef}
      className="relative isolate flex flex-col overflow-hidden pt-16"
    >
      <CursorGlow />

      {/*
        Two background layers, in this order for a reason. The constellation
        stays — Three.js is a TRD §1 stack requirement and a network is the
        right metaphor — but at a fraction of its former opacity, so it reads
        as distant texture. The bloom sits over it and is what the eye actually
        receives. Previously the wireframe was the dominant layer and its hard
        lines crossed the headline at reading size.
      */}
      <div ref={sceneRef} className="absolute inset-0 -z-20 opacity-[0.18]">
        <SceneCanvas createScene={createHeroNetworkScene} />
      </div>
      <Aurora className="-z-10" />

      <Container className="relative flex flex-col items-center gap-6 py-14 text-center sm:py-16">
        <FadeIn>
          {/* Glass pill rather than a filled badge: it belongs to the
              atmosphere behind it instead of sitting on top as a sticker. */}
          <span className="glass text-surface-foreground inline-flex items-center gap-2 rounded-full py-1.5 pr-4 pl-3 text-xs font-medium">
            <Sparkles className="text-primary size-3.5" />
            Now in public beta
          </span>
        </FadeIn>

        <FadeIn delay={0.1} blur>
          <h1 className="font-display mx-auto max-w-4xl text-5xl leading-[0.95] font-semibold tracking-[-0.03em] text-balance sm:text-7xl md:text-[5.5rem]">
            Build in public.
            <br />
            {/* One accent line, solid rather than a gradient. A two-stop
                gradient across a headline is the reflex choice and reads as
                decoration; a single confident violet reads as a decision. */}
            <span className="relative inline-block">
              <span
                aria-hidden="true"
                className="text-primary absolute inset-0 opacity-60 blur-[40px]"
              >
                Find your people.
              </span>
              <span className="text-primary relative">Find your people.</span>
            </span>
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <p className="text-muted-foreground max-w-xl text-lg leading-relaxed text-balance">
            ForgeHub is where developers, designers, and founders share their progress,
            recruit collaborators, and launch — out loud, together.
          </p>
        </FadeIn>

        <FadeIn delay={0.3} className="flex flex-col items-center gap-3 sm:flex-row">
          <MagneticButton>
            <Button asChild variant="primary" size="lg" className="rim-primary">
              <Link href={routes.auth.signup}>
                Start building free
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </MagneticButton>
          <Button asChild variant="outline" size="lg" className="glass">
            <a href="#demo">
              <Play className="size-4" />
              See it in action
            </a>
          </Button>
        </FadeIn>

        <FadeIn delay={0.35}>
          <p className="text-muted-foreground/70 text-xs">
            Free while in beta · No credit card · Your projects stay yours
          </p>
        </FadeIn>

        {/* The preview spans the full container, which is the point: the copy
            above it is a centred column roughly 600px wide inside a 1152px
            page, and this is what closes that gap on both sides. It also lets
            the hero show the product instead of only describing it. */}
        <FadeIn delay={0.45} className="mt-6 w-full">
          <HeroPreview />
        </FadeIn>
      </Container>

      {/* The strip anchors the bottom of the hero, the way the reference's
          integration row does — and gives the tall section a floor. */}
      <FadeIn delay={0.55} className="relative pb-16">
        <Container>
          <p className="text-muted-foreground/60 text-center text-xs tracking-[0.18em] uppercase">
            Ship with the stack you already use
          </p>
          <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {STACKS.map((stack) => (
              <li
                key={stack}
                className="text-muted-foreground/80 hover:text-foreground font-display text-sm font-medium transition-colors"
              >
                {stack}
              </li>
            ))}
          </ul>
        </Container>
      </FadeIn>
    </section>
  );
}
