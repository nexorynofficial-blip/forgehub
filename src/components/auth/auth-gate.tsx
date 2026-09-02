"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { routes } from "@/lib/routes";
import { useAuth } from "@/providers/auth-provider";

/**
 * Route gating for the two halves of the app.
 *
 * Deliberately client-side. The access token is memory-only and the refresh
 * cookie is `httpOnly` and scoped to `/api/v1/auth`, so Next.js middleware
 * could not actually verify a session — it would only be able to guess from
 * the presence of an opaque cookie it cannot validate. Gating where the auth
 * state genuinely lives is the honest version.
 */

function AuthPending() {
  return (
    <div
      className="flex min-h-screen items-center justify-center"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="text-muted-foreground size-6 animate-spin" />
      <span className="sr-only">Checking your session…</span>
    </div>
  );
}

/**
 * Wraps every authenticated route.
 *
 * Children are rendered only once the session is confirmed, so protected
 * content can never flash before the redirect lands.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace(routes.auth.login);
    }
  }, [status, router]);

  if (status !== "authenticated") {
    return <AuthPending />;
  }

  return <>{children}</>;
}

/**
 * Wraps the sign-in/sign-up routes.
 *
 * Someone already signed in has no business on the login page; send them to
 * the authenticated default route instead.
 */
export function RedirectIfAuthenticated({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(routes.dashboard);
    }
  }, [status, router]);

  if (status !== "unauthenticated") {
    return <AuthPending />;
  }

  return <>{children}</>;
}
