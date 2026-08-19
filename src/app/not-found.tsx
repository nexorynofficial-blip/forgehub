import Link from "next/link";
import { Compass } from "lucide-react";

import { routes } from "@/lib/routes";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <span className="bg-primary/15 text-primary mb-6 flex size-16 items-center justify-center rounded-full">
        <Compass className="size-7" />
      </span>
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="text-muted-foreground mt-2 max-w-sm text-sm">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Button asChild className="mt-8">
        <Link href={routes.home}>Back home</Link>
      </Button>
    </div>
  );
}
