import * as React from "react";

import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "border-border bg-surface text-foreground flex min-h-24 w-full rounded-md border px-4 py-3 text-sm",
      "placeholder:text-muted-foreground transition-colors duration-150",
      "focus-visible:ring-ring focus-visible:border-transparent focus-visible:ring-2 focus-visible:outline-none",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-invalid:border-danger aria-invalid:ring-danger",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
