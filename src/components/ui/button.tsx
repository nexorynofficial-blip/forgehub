"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "framer-motion";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium " +
    "transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-glow-primary)]",
        secondary:
          "bg-surface text-foreground border border-border-strong hover:bg-muted",
        ghost: "text-foreground hover:bg-muted",
        outline:
          "border border-border text-foreground hover:bg-muted hover:border-border-strong",
        danger: "bg-danger text-danger-foreground hover:bg-danger/90",
        link: "text-primary underline-offset-4 hover:underline p-0 h-auto",
      },
      size: {
        sm: "h-9 px-4",
        md: "h-11 px-6",
        lg: "h-12 px-8 text-base",
        icon: "size-10 p-0",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

/** Framer Motion's event props (onDrag, onAnimationStart, ...) collide with
 * React's native DOM event types of the same name; omitted here since
 * `Button` renders through `motion.create()` for tap/hover feedback. */
type NativeButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  | "onDrag"
  | "onDragStart"
  | "onDragEnd"
  | "onAnimationStart"
  | "onAnimationEnd"
  | "onAnimationIteration"
>;

export interface ButtonProps
  extends NativeButtonProps, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const MotionButton = motion.create("button");
const MotionSlot = motion.create(Slot);

/** Every button gets a small tactile press/hover response (UI_UX.md §5
 * micro-interactions); `MotionConfig reducedMotion="user"` at the app root
 * (providers/app-providers.tsx) makes these no-op automatically under
 * `prefers-reduced-motion`, so no manual check is needed here. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? MotionSlot : MotionButton;
    return (
      <Comp
        ref={ref}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.96 }}
        transition={{ type: "spring", stiffness: 500, damping: 25 }}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
