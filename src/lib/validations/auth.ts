import { z } from "zod";

/** Exported so other domains (e.g. validations/settings.ts's password
 * change form) share the exact same rules instead of redefining them. */
export const email = z
  .string()
  .trim()
  .min(1, "Email is required")
  .email("Enter a valid email address");

export const password = z
  .string()
  .min(8, "Must be at least 8 characters")
  .regex(/[A-Z]/, "Must include an uppercase letter")
  .regex(/[0-9]/, "Must include a number");

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean(),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const signupSchema = z
  .object({
    displayName: z.string().trim().min(2, "Must be at least 2 characters"),
    email,
    password,
    confirmPassword: z.string(),
    agreeToTerms: z.boolean().refine((value) => value, {
      message: "You must agree to the terms to continue",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });
export type SignupValues = z.infer<typeof signupSchema>;

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export const twoFactorSchema = z.object({
  code: z.string().length(6, "Enter all 6 digits"),
});
export type TwoFactorValues = z.infer<typeof twoFactorSchema>;

/**
 * Completing a password reset from an emailed link.
 *
 * Mirrors the backend's `resetPasswordSchema` field-for-field — `token`,
 * `password`, `confirmPassword` — so the form cannot pass locally and then be
 * rejected on submit. The token is not a user-editable field; it comes from
 * the link's query string and is carried through the form so a single schema
 * describes the whole request body.
 */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });
export type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;
