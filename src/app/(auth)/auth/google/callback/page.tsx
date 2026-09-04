import { Suspense } from "react";
import type { Metadata } from "next";
import { Loader2 } from "lucide-react";

import { GoogleCallback } from "./google-callback";

export const metadata: Metadata = { title: "Signing you in" };

/**
 * Where the backend sends the browser after Google, success or failure.
 *
 * The Suspense boundary is required, not decorative: `useSearchParams()` in
 * the client component below opts its subtree out of prerendering, and
 * without a boundary that would take the whole route with it and fail the
 * build.
 */
export default function GoogleCallbackPage() {
  return (
    <Suspense
      fallback={
        <div
          className="flex flex-col items-center gap-4 py-10"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="text-primary size-8 animate-spin" />
          <p className="text-muted-foreground text-sm">Signing you in…</p>
        </div>
      }
    >
      <GoogleCallback />
    </Suspense>
  );
}
