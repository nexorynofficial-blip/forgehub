"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

import { gsap, registerGsap } from "@/lib/gsap";
import { routes } from "@/lib/routes";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { Container } from "@/components/layout/container";
import { CursorGlow } from "@/components/motion/cursor-glow";
import { FadeIn } from "@/components/motion/fade-in";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { SceneCanvas } from "@/components/three";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingBuilderCards } from "@/components/marketing/floating-builder-cards";
import { createHeroNetworkScene } from "@/components/marketing/hero-scene";

/** UI_UX.md §5 "Parallax" — GSAP's documented job (ARCHITECTURE.md §6:
 * "scroll-linked and timeline-driven work"), which had gone completely
 * unused up through Phase 11 despite being a TRD.md §1 stack requirement.
 * The 3D scene drifts and fades slower than the scroll as the hero leaves
 * the viewport. See docs/ASSUMPTIONS.md (Phase 12). */
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

  return (
    <section
      ref={sectionRef}
      className="relative isolate flex min-h-screen items-center overflow-hidden pt-16"
    >
      <CursorGlow />

      <div ref={sceneRef} className="absolute inset-0 -z-10 opacity-80">
        <SceneCanvas createScene={createHeroNetworkScene} />
      </div>
      <div
        aria-hidden="true"
        className="from-background pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t to-transparent"
      />

      <FloatingBuilderCards />

      <Container className="relative flex flex-col items-center gap-8 py-24 text-center">
        <FadeIn>
          <Badge variant="primary">
            <Sparkles className="size-3" />
            Now in public beta
          </Badge>
        </FadeIn>

        <FadeIn delay={0.1} blur>
          <h1 className="font-display max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl md:text-7xl">
            Build in public.
            <br />
            <span className="relative inline-block">
              <span
                aria-hidden="true"
                className="gradient-text-brand absolute inset-0 opacity-70 blur-2xl"
              >
                Find your people.
              </span>
              <span className="gradient-text-brand relative">Find your people.</span>
            </span>
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <p className="text-muted-foreground max-w-xl text-lg text-balance">
            ForgeHub is where developers, designers, and founders share their progress,
            recruit collaborators, and launch — out loud, together.
          </p>
        </FadeIn>

        <FadeIn delay={0.3} className="flex flex-col items-center gap-4 sm:flex-row">
          <MagneticButton>
            <Button asChild variant="primary" size="lg">
              <Link href={routes.auth.signup}>
                Start building free
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </MagneticButton>
          <Button asChild variant="outline" size="lg">
            <a href="#features">See how it works</a>
          </Button>
        </FadeIn>
      </Container>
    </section>
  );
}
