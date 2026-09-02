"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Mail } from "lucide-react";

import { routes } from "@/lib/routes";
import { apiErrorMessage } from "@/lib/api";
import { resendVerificationEmail } from "@/lib/services/auth-service";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { FadeIn } from "@/components/motion/fade-in";

const RESEND_COOLDOWN_SECONDS = 30;

export function VerifyEmailPanel({ email }: { email?: string }) {
  const toast = useToast((state) => state.toast);
  const [isResending, setIsResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

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
