import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/** Vertical rhythm wrapper for page sections. `relative isolate
 * overflow-hidden` gives each section its own stacking/clipping context so
 * decorative absolutely-positioned content (e.g. `AmbientGlow`) can bleed
 * off-edge without ever causing horizontal scroll. */
export function Section({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("relative isolate overflow-hidden py-20 sm:py-28", className)}
      {...props}
    />
  );
}
