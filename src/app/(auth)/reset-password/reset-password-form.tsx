"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, useWatch } from "react-hook-form";
import { CheckCircle2, LinkIcon, Loader2 } from "lucide-react";

import { routes } from "@/lib/routes";
import { ApiError, apiErrorMessage, applyApiFieldErrors } from "@/lib/api";
import { resetPassword } from "@/lib/services/auth-service";
import { resetPasswordSchema, type ResetPasswordValues } from "@/lib/validations/auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { AuthHeading } from "@/components/auth/auth-heading";
import { PasswordInput } from "@/components/auth/password-input";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";
import { FadeIn } from "@/components/motion/fade-in";

/**
 * Completing a password reset.
 *
 * Three terminal states, because a reset link has three ways of ending:
 * arriving without a token at all, arriving with one the server rejects, and
 * succeeding. The middle case is deliberately *not* a toast — an expired link
 * is not something the user can fix by retyping the form, so the form is
 * replaced by the one action that helps: request a fresh link.
 */
export function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const toast = useToast((state) => state.toast);
  const [isDone, setIsDone] = useState(false);
  const [isLinkInvalid, setIsLinkInvalid] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token: token ?? "", password: "", confirmPassword: "" },
  });

  const password = useWatch({ control, name: "password" });

  async function onSubmit(values: ResetPasswordValues) {
    try {
      await resetPassword(values);
      setIsDone(true);
    } catch (error) {
      // A password-rule failure is a field error the user can act on.
      if (applyApiFieldErrors(error, setError, ["password", "confirmPassword"])) return;

      // A rejected *token* also arrives as a 422, but with no field to attach
      // it to — `AppError.validation("This reset link is invalid or has
      // expired")` carries no details. That is the link-level failure.
      if (error instanceof ApiError && error.isValidationError) {
        setIsLinkInvalid(true);
        return;
      }

      toast({
        variant: "danger",
        title: "Could not reset your password",
        description: apiErrorMessage(error, "Please try again in a moment."),
      });
    }
  }

  if (isDone) {
    return (
      <FadeIn className="text-center">
        <div className="bg-success/15 text-success mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <CheckCircle2 className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Password updated
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Every device has been signed out for your security. Sign in again with your new
          password.
        </p>
        <Button size="lg" className="mt-8" onClick={() => router.push(routes.auth.login)}>
          Go to sign in
        </Button>
      </FadeIn>
    );
  }

  if (!token || isLinkInvalid) {
    return (
      <FadeIn className="text-center">
        <div className="bg-accent/15 text-accent mx-auto mb-6 flex size-14 items-center justify-center rounded-full">
          <LinkIcon className="size-6" />
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          This link is no longer valid
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Reset links expire and can only be used once. Request a new one and we&apos;ll
          email it straight over.
        </p>
        <Button size="lg" className="mt-8" asChild>
          <Link href={routes.auth.forgotPassword}>Request a new link</Link>
        </Button>
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
    <div>
      <AuthHeading
        title="Choose a new password"
        description="Pick something you haven't used here before."
      />

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
        {/* The token is part of the request body, not something to retype. */}
        <input type="hidden" {...register("token")} />

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            placeholder="••••••••"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? "password-error" : "password-strength"}
            {...register("password")}
          />
          <PasswordStrengthMeter password={password ?? ""} />
          {errors.password ? (
            <p id="password-error" className="text-danger text-sm">
              {errors.password.message}
            </p>
          ) : (
            <p id="password-strength" className="text-muted-foreground text-xs">
              At least 8 characters, one uppercase letter, one number.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <PasswordInput
            id="confirmPassword"
            autoComplete="new-password"
            placeholder="••••••••"
            aria-invalid={!!errors.confirmPassword}
            aria-describedby={
              errors.confirmPassword ? "confirmPassword-error" : undefined
            }
            {...register("confirmPassword")}
          />
          {errors.confirmPassword && (
            <p id="confirmPassword-error" className="text-danger text-sm">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Update password
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
