import type { ElementType, HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface ContainerProps extends HTMLAttributes<HTMLDivElement> {
  as?: ElementType;
}

/** Centered, max-width content wrapper reused by every page (UI_UX.md "Lots of whitespace"). */
export function Container({ as: Comp = "div", className, ...props }: ContainerProps) {
  return (
    <Comp className={cn("mx-auto w-full max-w-6xl px-6 sm:px-8", className)} {...props} />
  );
}
