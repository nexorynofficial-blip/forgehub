"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Loader2 } from "lucide-react";

import { routes } from "@/lib/routes";
import { apiErrorMessage, applyApiFieldErrors } from "@/lib/api";
import { useAuth } from "@/providers/auth-provider";
import { signupSchema, type SignupValues } from "@/lib/validations/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { AuthHeading } from "@/components/auth/auth-heading";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { PasswordInput } from "@/components/auth/password-input";
import { PasswordStrengthMeter } from "@/components/auth/password-strength-meter";

export function SignupForm() {
  const router = useRouter();
  const toast = useToast((state) => state.toast);
  const { signup } = useAuth();
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      displayName: "",
      email: "",
      password: "",
      confirmPassword: "",
      agreeToTerms: false,
    },
  });

  const password = useWatch({ control, name: "password" });

  async function onSubmit(values: SignupValues) {
    try {
      // Registration never signs the user in: the backend answers with
      // `verificationRequired` and no token, so the next stop is verification.
      await signup(values);
      toast({
        title: "Account created",
        description: "Next up: verify your email.",
      });
      router.push(`${routes.auth.verifyEmail}?email=${encodeURIComponent(values.email)}`);
    } catch (error) {
      if (
        applyApiFieldErrors(error, setError, [
          "displayName",
          "email",
          "password",
          "confirmPassword",
          "agreeToTerms",
        ])
      ) {
        return;
      }

      toast({
        variant: "danger",
        title: "Could not create your account",
        description: apiErrorMessage(error, "Please check your details and try again."),
      });
    }
  }

  return (
    <div>
      <AuthHeading
        title="Create your account"
        description="Start building in public today."
      />

      <OAuthButtons />

      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs">OR</span>
        <Separator className="flex-1" />
      </div>

      <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="displayName">Name</Label>
          <Input
            id="displayName"
            autoComplete="name"
            placeholder="Ava Whitfield"
            aria-invalid={!!errors.displayName}
            aria-describedby={errors.displayName ? "displayName-error" : undefined}
            {...register("displayName")}
          />
          {errors.displayName && (
            <p id="displayName-error" className="text-danger text-sm">
              {errors.displayName.message}
            </p>
          )}
        </div>

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

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
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
          <Label htmlFor="confirmPassword">Confirm password</Label>
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

        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <Controller
              control={control}
              name="agreeToTerms"
              render={({ field }) => (
                <Checkbox
                  id="agreeToTerms"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-invalid={!!errors.agreeToTerms}
                  className="mt-0.5"
                />
              )}
            />
            <Label htmlFor="agreeToTerms" className="text-muted-foreground font-normal">
              I agree to the Terms of Service and Privacy Policy
            </Label>
          </div>
          {errors.agreeToTerms && (
            <p className="text-danger text-sm">{errors.agreeToTerms.message}</p>
          )}
        </div>

        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Create account
        </Button>
      </form>

      <p className="text-muted-foreground mt-8 text-center text-sm">
        Already have an account?{" "}
        <Link
          href={routes.auth.login}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
