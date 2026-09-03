"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, LinkIcon, Loader2, Mail } from "lucide-react";

import { routes } from "@/lib/routes";
import { apiErrorMessage } from "@/lib/api";
import { resendVerificationEmail, verifyEmail } from "@/lib/services/auth-service";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FadeIn } from "@/components/motion/fade-in";

const RESEND_COOLDOWN_SECONDS = 30;

/** Which of the three panels below is showing. */
type VerificationState = "idle" | "verifying" | "verified" | "failed";

export function VerifyEmailPanel({ email, token }: { email?: string; token?: string }) {
  const toast = useToast((state) => state.toast);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [state, setState] = useState<VerificationState>(token ? "verifying" : "idle");

  /**
   * A verification token is single-use and consumed atomically server-side, so
   * firing twice would turn the second attempt into a spurious "link expired".
   * React 19 Strict Mode runs effects twice in development, which is exactly
   * that scenario — hence the guard rather than a bare effect.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    verifyEmail(token)
      .then(() => setState("verified"))
      .catch(() => setState("failed"));
  }, [token]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function handleResend() {
    if (!email) {
      toast({
        variant: "danger",
        title: "No address to send to",
        description: "Head back to sign-in and start again.",
      });
      return;
    }

    setIsResending(true);
    try {
      await resendVerificationEmail(email);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast({ title: "Email sent", description: "Check your inbox (and spam folder)." });
    } catch (error) {
      toast({
        variant: "danger",
        title: "Could not resend the email",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    } finally {
      setIsResending(false);
    }
  }

  if (state === "verifying") {
    return (
      <FadeIn className="text-center">
        <div className="bg-primary/15 text-primary mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <Loader2 className="size-6 animate-spin" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Verifying your email
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">This only takes a moment.</p>
      </FadeIn>
    );
  }

  if (state === "verified") {
    return (
      <FadeIn className="text-center">
        <div className="bg-success/15 text-success mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <CheckCircle2 className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Email verified
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Your account is active. Sign in to start building.
        </p>
        {/* Verification does not sign the user in — the backend returns the
            user record and no access token — so the next stop is login. */}
        <Button size="lg" className="mt-8" asChild>
          <Link href={routes.auth.login}>Go to sign in</Link>
        </Button>
      </FadeIn>
    );
  }

  if (state === "failed") {
    return (
      <FadeIn className="text-center">
        <div className="bg-accent/15 text-accent mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <LinkIcon className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          This link is no longer valid
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Verification links expire and can only be used once
          {email ? "" : ". Sign in and we can send you a fresh one"}.
        </p>
        {email && (
          <Button
            variant="secondary"
            className="mt-8"
            onClick={handleResend}
            disabled={isResending || cooldown > 0}
          >
            {isResending && <Loader2 className="size-4 animate-spin" />}
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new link"}
          </Button>
        )}
        <p className="text-muted-foreground mt-6 text-sm">
          <Link
            href={routes.auth.login}
            className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          >
            Back to sign in
          </Link>
        </p>
      </FadeIn>
    );
  }

  return (
    <FadeIn className="text-center">
      <div className="bg-primary/15 text-primary mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
        <Mail className="size-6" />
      </div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Verify your email
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        We sent a verification link to{" "}
        <span className="text-foreground font-medium">
          {email ?? "your email address"}
        </span>
        . Click it to activate your account.
      </p>

      <Button
        variant="secondary"
        className="mt-8"
        onClick={handleResend}
        disabled={isResending || cooldown > 0}
      >
        {isResending && <Loader2 className="size-4 animate-spin" />}
        {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend email"}
      </Button>

      <p className="text-muted-foreground mt-6 text-sm">
        Wrong email?{" "}
        <Link
          href={routes.auth.signup}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Back to sign up
        </Link>
      </p>
    </FadeIn>
  );
}
