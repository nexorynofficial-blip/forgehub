"use client";

import { motion, type HTMLMotionProps } from "framer-motion";

interface RevealOnScrollProps extends HTMLMotionProps<"div"> {
  delay?: number;
  /** Cinematic variant for section-level statements (headings) — a slower,
   * blur-to-sharp pull that reads as more deliberate than the snappier
   * plain fade used for grid items/cards, so motion carries emphasis
   * instead of every element moving identically. */
  blur?: boolean;
}

/** Fades/slides content in the first time it scrolls into view (UI_UX.md §12). */
export function RevealOnScroll({
  delay = 0,
  blur = false,
  children,
  ...props
}: RevealOnScrollProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, filter: blur ? "blur(12px)" : "blur(0px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: blur ? 0.9 : 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
