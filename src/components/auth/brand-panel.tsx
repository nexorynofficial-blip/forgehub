import { Quote } from "lucide-react";

import { mockTestimonials } from "@/lib/mock/testimonials";
import { FadeIn } from "@/components/motion/fade-in";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const testimonial = mockTestimonials[0];

/** Left panel of the split-screen auth shell. CSS gradients instead of a
 * second Three.js instance — auth pages should load fast, not showcase
 * WebGL (see docs/ASSUMPTIONS.md). */
export function BrandPanel() {
  return (
    <div className="bg-surface relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, rgb(124 92 255 / 25%), transparent 55%), " +
            "radial-gradient(circle at 80% 70%, rgb(0 212 255 / 18%), transparent 50%)",
        }}
      />

      <FadeIn className="relative">
        <p className="font-display text-lg font-semibold tracking-tight">
          Forge<span className="gradient-text-brand">Hub</span>
        </p>
      </FadeIn>

      <FadeIn delay={0.1} className="relative max-w-md">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-balance">
          Build in public. <span className="gradient-text-brand">Find your people.</span>
        </h2>
        <p className="text-muted-foreground mt-4 text-base">
          Join thousands of developers, designers, and founders shipping in the open.
        </p>
      </FadeIn>

      {testimonial && (
        <FadeIn delay={0.2} className="glass relative max-w-sm rounded-lg p-5">
          <Quote className="text-primary size-4" />
          <p className="text-foreground mt-3 text-sm leading-relaxed">
            “{testimonial.quote}”
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Avatar className="size-8">
              <AvatarFallback>{testimonial.authorName.charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-foreground text-sm font-medium">
                {testimonial.authorName}
              </p>
              <p className="text-muted-foreground text-xs">{testimonial.authorRole}</p>
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}
