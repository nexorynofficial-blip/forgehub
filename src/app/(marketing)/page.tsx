import { CommunitiesSection } from "@/components/marketing/communities-section";
import { CtaSection } from "@/components/marketing/cta-section";
import { FaqSection } from "@/components/marketing/faq-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { HeroSection } from "@/components/marketing/hero-section";
import { HowItWorksSection } from "@/components/marketing/how-it-works-section";
import { LiveDemoSection } from "@/components/marketing/live-demo-section";
import { TestimonialsSection } from "@/components/marketing/testimonials-section";

/**
 * The public landing page.
 *
 * The platform-statistics band that sat under the hero is gone. There is no
 * public stats endpoint, and the four counters it rendered ("Builders",
 * "Projects shipped", "Collaborations formed", "Countries") were fixtures
 * presented as facts about the platform. Exposing the admin-only
 * `GET /admin/stats` to fill them would widen an authorization boundary for a
 * cosmetic reason, so the section is removed until a public endpoint exists.
 */
export default function LandingPage() {
  return (
    <>
      <HeroSection />
      {/* Sequence before capability: "how does this work" is the question a
          visitor has immediately after the hero, and the feature grid reads
          better once the three steps have framed it. */}
      <HowItWorksSection />
      <FeaturesSection />
      <LiveDemoSection />
      <CommunitiesSection />
      <TestimonialsSection />
      {/* Objections last, right before the ask — the CTA is more persuasive
          after the doubts have been answered than before them. */}
      <FaqSection />
      <CtaSection />
    </>
  );
}
