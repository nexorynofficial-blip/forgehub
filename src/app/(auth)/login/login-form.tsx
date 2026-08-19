"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { Loader2 } from "lucide-react";

import { routes } from "@/lib/routes";
import { login } from "@/lib/services/auth-service";
import { loginSchema, type LoginValues } from "@/lib/validations/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { AuthHeading } from "@/components/auth/auth-heading";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import { PasswordInput } from "@/components/auth/password-input";

export function LoginForm() {
  const router = useRouter();
  const toast = useToast((state) => state.toast);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "", rememberMe: false },
  });

  async function onSubmit(values: LoginValues) {
    await login(values);
    toast({ title: "Welcome back", description: "Signed in successfully." });
    router.push(routes.dashboard);
  }

  return (
    <div>
      <AuthHeading title="Welcome back" description="Sign in to keep building." />

      <OAuthButtons />

      <div className="my-6 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs">OR</span>
        <Separator className="flex-1" />
      </div>

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

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href={routes.auth.forgotPassword}
              className="text-primary focus-visible:ring-ring rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? "password-error" : undefined}
            {...register("password")}
          />
          {errors.password && (
            <p id="password-error" className="text-danger text-sm">
              {errors.password.message}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Controller
            control={control}
            name="rememberMe"
            render={({ field }) => (
              <Checkbox
                id="rememberMe"
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <Label htmlFor="rememberMe" className="text-muted-foreground font-normal">
            Remember me for 30 days
          </Label>
        </div>

        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </Button>
      </form>

      <p className="text-muted-foreground mt-8 text-center text-sm">
        Don&apos;t have an account?{" "}
        <Link
          href={routes.auth.signup}
          className="text-primary focus-visible:ring-ring rounded-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}
