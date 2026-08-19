import { cn } from "@/lib/utils";

const VARIANTS = {
  primary: "bg-primary/25",
  secondary: "bg-secondary/20",
  accent: "bg-accent/20",
} as const;

interface AmbientGlowProps {
  variant?: keyof typeof VARIANTS;
  className?: string;
}

/** A large, heavily blurred color blob positioned behind section content —
 * gives each section its own depth/asymmetric rhythm instead of every
 * section reading as an identical flat black box (the palette's `accent`
 * gold otherwise never appears anywhere on the landing page). Purely
 * decorative; sized to bleed past its `Section`'s `overflow-hidden`. */
export function AmbientGlow({ variant = "primary", className }: AmbientGlowProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -z-10 size-[28rem] rounded-full blur-[130px]",
        VARIANTS[variant],
        className,
      )}
    />
  );
}
