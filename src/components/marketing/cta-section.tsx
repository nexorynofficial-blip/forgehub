import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { routes } from "@/lib/routes";
import { Container } from "@/components/layout/container";
import { Section } from "@/components/layout/section";
import { AmbientGlow } from "@/components/marketing/ambient-glow";
import { MagneticButton } from "@/components/motion/magnetic-button";
import { RevealOnScroll } from "@/components/motion/reveal-on-scroll";
import { Button } from "@/components/ui/button";

/** The page's closing statement — deliberately the most visually dramatic
 * moment on the landing page (two overlapping glows, a stronger gradient
 * wash) rather than another identical glass card, since this is the last
 * thing a visitor sees before converting or leaving. */
export function CtaSection() {
  return (
    <Section>
      <Container>
        <RevealOnScroll
          blur
          className="glass-strong relative isolate overflow-hidden rounded-lg px-8 py-20 text-center sm:px-16 sm:py-24"
        >
          <AmbientGlow variant="primary" className="-top-24 -left-24" />
          <AmbientGlow variant="accent" className="-right-24 -bottom-24" />
          <div
            aria-hidden="true"
            className="gradient-brand pointer-events-none absolute inset-0 -z-10 opacity-15"
          />
          <h2 className="font-display mx-auto max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
            Your next project deserves an audience.
          </h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-md text-lg">
            Create a profile, post your first update, and start building in public today.
          </p>
          <MagneticButton className="mt-8 inline-block">
            <Button asChild variant="primary" size="lg">
              <Link href={routes.auth.signup}>
                Create your profile
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </MagneticButton>
        </RevealOnScroll>
      </Container>
    </Section>
  );
}
