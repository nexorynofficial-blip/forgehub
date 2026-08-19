import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "border-border bg-surface text-foreground flex h-11 w-full rounded-md border px-4 text-sm",
      "placeholder:text-muted-foreground transition-colors duration-150",
      "focus-visible:ring-ring focus-visible:border-transparent focus-visible:ring-2 focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-invalid:border-danger aria-invalid:ring-danger",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";
