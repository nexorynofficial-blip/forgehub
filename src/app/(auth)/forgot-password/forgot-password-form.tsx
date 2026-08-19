"use client";

import { useState } from "react";
import Link from "next/link";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Loader2, MailCheck } from "lucide-react";

import { routes } from "@/lib/routes";
import { requestPasswordReset } from "@/lib/services/auth-service";
import { forgotPasswordSchema, type ForgotPasswordValues } from "@/lib/validations/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthHeading } from "@/components/auth/auth-heading";
import { FadeIn } from "@/components/motion/fade-in";

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values: ForgotPasswordValues) {
    await requestPasswordReset(values.email);
    setSentTo(values.email);
  }

  if (sentTo) {
    return (
      <FadeIn className="text-center">
        <div className="bg-success/15 text-success mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <MailCheck className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Check your email
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          If an account exists for{" "}
          <span className="text-foreground font-medium">{sentTo}</span>, a reset link is
          on its way.
        </p>
        <Button variant="ghost" className="mt-8" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </FadeIn>
    );
  }

  return (
    <div>
      <AuthHeading
        title="Forgot your password?"
        description="Enter your email and we'll send you a reset link."
      />

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p id="email-error" className="text-danger text-sm">
              {errors.email.message}
            </p>
          )}
        </div>

        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Send reset link
        </Button>
      </form>

      <p className="text-muted-foreground mt-8 text-center text-sm">
        <Link
          href={routes.auth.login}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
