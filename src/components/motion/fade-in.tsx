"use client";

import { motion, type HTMLMotionProps } from "framer-motion";

interface FadeInProps extends HTMLMotionProps<"div"> {
  delay?: number;
  y?: number;
  /** Cinematic variant for hero-weight statements — adds a blur-to-sharp
   * focus pull on top of the usual fade+slide, distinct from the snappier
   * plain fade used for grid/UI-chrome elements (motion should carry
   * emphasis, not just presence). */
  blur?: boolean;
}

/**
 * Standard entrance animation for above-the-fold content. Respects
 * prefers-reduced-motion automatically via the app-wide MotionConfig.
 */
export function FadeIn({
  delay = 0,
  y = 12,
  blur = false,
  children,
  ...props
}: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y, filter: blur ? "blur(10px)" : "blur(0px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      transition={{ duration: blur ? 0.8 : 0.5, delay, ease: [0.16, 1, 0.3, 1] }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
