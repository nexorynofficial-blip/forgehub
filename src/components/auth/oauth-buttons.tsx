"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { GOOGLE_OAUTH_ENABLED, googleSignInUrl } from "@/lib/oauth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { GoogleIcon } from "@/components/auth/oauth-icons";

/**
 * Federated sign-in, on both the login and signup forms.
 *
 * One provider flow, not two. Signing up and signing in are the same
 * navigation — whether an account gets created is the backend's answer to
 * "have I seen this Google identity before", which is the only place that
 * question can be answered correctly anyway.
 *
 * The whole block, divider included, renders only when Google sign-in is
 * actually available. This previously shipped two buttons whose only effect
 * was a toast saying OAuth was not wired up; a control that cannot do what it
 * says is worse than an absent one, so with the provider off there is nothing
 * here and the password form stands alone. The GitHub button is gone for that
 * reason and no other: PRD §4.1 still lists it, and it belongs back here the
 * day there is an implementation behind it.
 */
export function OAuthButtons({ next }: { next?: string }) {
  const [isRedirecting, setIsRedirecting] = useState(false);

  if (!GOOGLE_OAUTH_ENABLED) return null;

  /**
   * `window.location` rather than the Next router: the destination is the
   * backend's origin, and from there the user has to actually travel to
   * Google's consent screen. A client-side navigation cannot leave the app,
   * and a `fetch` would be stopped by CORS at the first redirect.
   */
  function startGoogleSignIn() {
    setIsRedirecting(true);
    window.location.assign(googleSignInUrl(next));
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={startGoogleSignIn}
        disabled={isRedirecting}
      >
        {isRedirecting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <GoogleIcon className="size-4" />
        )}
        {isRedirecting ? "Redirecting to Google…" : "Continue with Google"}
      </Button>

      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs">OR</span>
        <Separator className="flex-1" />
      </div>
    </>
  );
}
