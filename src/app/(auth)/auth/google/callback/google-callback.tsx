"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";

import { oauthErrorMessage, safeInternalPath } from "@/lib/oauth";
import { routes } from "@/lib/routes";
import { useAuth } from "@/providers/auth-provider";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";

/**
 * Finishing a Google sign-in.
 *
 * By the time this renders the work is already done: the backend validated
 * the callback, created or linked the account, and set the ordinary refresh
 * cookie. What is left is to turn that cookie into a session in this tab,
 * which is exactly what `refreshSession()` does after any reload — so there
 * is no OAuth-specific session path, and nothing here knows what a provider
 * token is.
 *
 * No token arrives in the URL, by design. The only thing the backend puts in
 * the query string is an opaque error code from a closed set, or the internal
 * path the user was heading to.
 */
export function GoogleCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const { refreshSession } = useAuth();

  const errorCode = params.get("error");
  const [failure, setFailure] = useState<string | null>(
    errorCode !== null ? oauthErrorMessage(errorCode) : null,
  );

  /**
   * React 18+ runs effects twice in development Strict Mode. `refreshSession`
   * rotates the refresh token, and rotation is single-use — a second call
   * would present the token the first one just retired, which the backend
   * correctly reads as theft and answers by killing the session. So this runs
   * once per mount, guarded by a ref rather than by a dependency list.
   */
  const started = useRef(false);

  useEffect(() => {
    if (errorCode !== null || started.current) return;
    started.current = true;

    let cancelled = false;

    void refreshSession()
      .then((session) => {
        if (cancelled) return;

        if (!session) {
          setFailure(oauthErrorMessage(null));
          return;
        }

        // Re-validated here even though the backend already checked it: this
        // value came out of a URL, and a URL is editable by whoever sends it.
        const next = safeInternalPath(params.get("next")) ?? routes.dashboard;
        // `replace`, so Back does not return to a spent callback URL.
        router.replace(next);
      })
      .catch(() => {
        if (!cancelled) setFailure(oauthErrorMessage(null));
      });

    return () => {
      cancelled = true;
    };
  }, [errorCode, params, refreshSession, router]);

  if (failure !== null) {
    return (
      <div>
        <div className="bg-danger/15 text-danger mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <AlertCircle className="size-6" />
        </div>
        <AuthHeading title="Sign-in didn't complete" description={failure} />

        <div className="mt-6 flex flex-col gap-3">
          <Button asChild size="lg" className="w-full">
            <Link href={routes.auth.login}>Back to sign in</Link>
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link href={routes.auth.forgotPassword}>Reset your password</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center gap-4 py-10"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="text-primary size-8 animate-spin" />
      <p className="text-muted-foreground text-sm">Signing you in…</p>
    </div>
  );
}
