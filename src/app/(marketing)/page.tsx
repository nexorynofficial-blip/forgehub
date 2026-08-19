import { CommunitiesSection } from "@/components/marketing/communities-section";
import { CtaSection } from "@/components/marketing/cta-section";
import { FeaturesSection } from "@/components/marketing/features-section";
import { HeroSection } from "@/components/marketing/hero-section";
import { LiveDemoSection } from "@/components/marketing/live-demo-section";
import { StatsSection } from "@/components/marketing/stats-section";
import { TestimonialsSection } from "@/components/marketing/testimonials-section";

export default function LandingPage() {
  return (
    <>
      <HeroSection />
      <StatsSection />
      <FeaturesSection />
      <LiveDemoSection />
      <CommunitiesSection />
      <TestimonialsSection />
      <CtaSection />
    </>
  );
}
