import { z } from "zod";

/**
 * Request validation (BACKEND_TRD.md §15).
 *
 * The password and email rules mirror the shipped frontend
 * (`src/lib/validations/auth.ts`) exactly — same minimums, same regexes, same
 * messages. Backend validation is authoritative, but where the frontend has
 * already told a user what is required, the server must not disagree, or a
 * form that passes locally would fail on submit for no visible reason.
 */

const email = z
  .string()
  .trim()
  .min(1, "Email is required")
  .email("Enter a valid email address")
  // Stored lowercase so `findUnique` on email is genuinely unique — Postgres
  // comparison is case-sensitive, so "A@x.com" and "a@x.com" would otherwise
  // be two accounts.
  .toLowerCase();

/** Mirrors the frontend's `password` rule verbatim. */
const password = z
  .string()
  .min(8, "Must be at least 8 characters")
  .max(200, "Must be at most 200 characters")
  .regex(/[A-Z]/, "Must include an uppercase letter")
  .regex(/[0-9]/, "Must include a number");

const displayName = z
  .string()
  .trim()
  .min(2, "Must be at least 2 characters")
  .max(60, "Must be at most 60 characters");

/** Opaque tokens are base64url; reject anything that cannot be one. */
const opaqueToken = z
  .string()
  .min(20, "Invalid token")
  .max(512, "Invalid token")
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid token");

/** Six digits, matching the frontend's `OtpInput` and `twoFactorSchema`. */
const totpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter all 6 digits");

const backupCode = z
  .string()
  .trim()
  .min(8, "Invalid backup code")
  .max(32, "Invalid backup code");

/* ── Registration & login ───────────────────────────────────────────────── */

/**
 * Accepts the frontend's full `SignupValues` payload, `confirmPassword` and
 * `agreeToTerms` included, so the existing form can post its values
 * unmodified. Both are re-checked here — frontend validation is supplementary
 * (TRD §15), and terms acceptance is recorded to the audit log.
 */
export const registerSchema = z
  .object({
    displayName,
    email,
    password,
    confirmPassword: z.string(),
    agreeToTerms: z.literal(true, {
      message: "You must agree to the terms to continue",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  // Not the `password` rule: rejecting a short password here would tell an
  // attacker their guess was malformed rather than wrong, and would lock out
  // legitimate users whose password predates a rule change.
  password: z.string().min(1, "Password is required"),
  rememberMe: z.boolean().default(false),
});

export type LoginInput = z.infer<typeof loginSchema>;

/* ── Email verification ─────────────────────────────────────────────────── */

export const verifyEmailSchema = z.object({ token: opaqueToken });
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({ email });
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

/* ── Password reset & change ────────────────────────────────────────────── */

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: opaqueToken,
    password,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Field names match the frontend's `changePasswordSchema`. */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: password,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Passwords don't match",
    path: ["confirmNewPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/* ── Two-factor authentication ──────────────────────────────────────────── */

export const twoFactorConfirmSchema = z.object({ code: totpCode });
export type TwoFactorConfirmInput = z.infer<typeof twoFactorConfirmSchema>;

/**
 * Disabling requires the password, not just a session: an attacker who
 * borrows an unlocked browser must not be able to strip the second factor.
 */
export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, "Password is required"),
});
export type TwoFactorDisableInput = z.infer<typeof twoFactorDisableSchema>;

/**
 * The challenge token may arrive in the body (native clients) or in the
 * httpOnly cookie set at login (browsers), so it is optional here and
 * resolved by the controller.
 */
export const twoFactorChallengeSchema = z
  .object({
    challengeToken: opaqueToken.optional(),
    code: totpCode.optional(),
    backupCode: backupCode.optional(),
  })
  .refine((data) => Boolean(data.code) !== Boolean(data.backupCode), {
    message: "Provide either a 6-digit code or a backup code",
    path: ["code"],
  });

export type TwoFactorChallengeInput = z.infer<typeof twoFactorChallengeSchema>;

/* ── Sessions ───────────────────────────────────────────────────────────── */

export const sessionIdParamSchema = z.object({
  id: z.string().uuid("Invalid session id"),
});
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;
