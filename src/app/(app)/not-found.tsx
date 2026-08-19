import Link from "next/link";
import { UserX } from "lucide-react";

import { routes } from "@/lib/routes";
import { Button } from "@/components/ui/button";

/** In-shell 404 — keeps AppSidebar/AppTopbar visible so a bad profile URL
 * (or any other unmatched `(app)` route) doesn't kick the user out of the
 * app chrome entirely. */
export default function AppNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-24 text-center">
      <span className="bg-primary/15 text-primary mb-6 flex size-16 items-center justify-center rounded-full">
        <UserX className="size-7" />
      </span>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm">
        That page doesn&apos;t exist, or the builder you&apos;re looking for isn&apos;t on
        ForgeHub.
      </p>
      <Button asChild className="mt-8">
        <Link href={routes.dashboard}>Back to dashboard</Link>
      </Button>
    </div>
  );
}
