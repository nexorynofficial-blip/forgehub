import { cn } from "@/lib/utils";

/** UI_UX.md §12 "Skeleton loaders everywhere". */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-muted animate-pulse rounded-md", className)}
      aria-hidden="true"
      {...props}
    />
  );
}
