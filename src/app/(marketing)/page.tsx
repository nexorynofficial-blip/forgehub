import { CommunitiesSection } from "@/components/marketing/communities-section";
import { CtaSection } from "@/components/marketing/cta-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { HeroSection } from "@/components/marketing/hero-section";
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
      <FeaturesSection />
      <LiveDemoSection />
      <CommunitiesSection />
      <TestimonialsSection />
      <CtaSection />
    </>
  );
}
