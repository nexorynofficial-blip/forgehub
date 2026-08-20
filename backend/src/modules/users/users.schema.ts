import { MessagePermission, NotificationType, ProfileVisibility } from "@prisma/client";
import { z } from "zod";

/**
 * Request validation for the users module (BACKEND_TRD.md §15).
 *
 * The username and profile rules mirror the shipped frontend
 * (`src/lib/validations/settings.ts`) exactly. Backend validation is
 * authoritative, but where the Settings form has already told a user what is
 * allowed, the server must not disagree — otherwise a form that validates
 * locally fails on submit with no visible cause.
 */

/**
 * Handles that would collide with a route segment or impersonate the system.
 *
 * `me` matters most: `/users/me` and `/users/:username` share a prefix, and
 * profile URLs are `/profile/[username]` on the frontend. Reserving these
 * costs nothing and avoids a class of routing bug that is painful to undo
 * once real accounts hold the names.
 */
const RESERVED_USERNAMES = new Set([
  "me",
  "admin",
  "administrator",
  "api",
  "auth",
  "login",
  "logout",
  "signup",
  "register",
  "settings",
  "support",
  "help",
  "forgehub",
  "null",
  "undefined",
]);

/** Mirrors the frontend's rule verbatim: min 3, `/^[a-z0-9._]+$/i`. */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Must be at least 3 characters")
  .max(30, "Must be at most 30 characters")
  .regex(/^[a-z0-9._]+$/i, "Letters, numbers, dots, and underscores only")
  // Stored lowercase so the unique index is genuinely case-insensitive —
  // Postgres comparison is case-sensitive, so "Ava" and "ava" would otherwise
  // be two different handles pointing at two different profiles.
  .toLowerCase()
  .refine((value) => !RESERVED_USERNAMES.has(value), {
    message: "That username is reserved",
  })
  // A handle of only dots/underscores is technically in-charset but unusable
  // as an identifier and looks like a rendering bug in a URL.
  .refine((value) => /[a-z0-9]/.test(value), {
    message: "Must contain at least one letter or number",
  });

const optionalUrl = z
  .union([z.string().trim().url("Enter a valid URL"), z.literal("")])
  .transform((value) => (value === "" ? null : value));

const socialLinkSchema = z.object({
  platform: z
    .string()
    .trim()
    .min(1, "Platform is required")
    .max(30)
    .regex(/^[a-z0-9_-]+$/i, "Letters, numbers, hyphens, and underscores only")
    .toLowerCase(),
  url: z.string().trim().url("Enter a valid URL").max(500),
});

/**
 * The Settings → Account payload.
 *
 * Every field is optional so the endpoint is a genuine PATCH, but the shipped
 * form submits the full set at once and this accepts exactly that shape.
 *
 * `email` is accepted and then rejected if changed — see the service. It is
 * in the schema only because the form sends it; silently dropping a field a
 * client believes it saved would be worse than an explicit error.
 */
export const updateProfileSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(2, "Must be at least 2 characters")
      .max(60, "Must be at most 60 characters")
      .optional(),
    username: usernameSchema.optional(),
    email: z
      .string()
      .trim()
      .email("Enter a valid email address")
      .toLowerCase()
      .optional(),
    bio: z.string().max(280, "Keep it under 280 characters").optional(),
    location: z.string().trim().max(100).nullable().optional(),
    websiteUrl: optionalUrl.optional(),
    experienceYears: z
      .number()
      .int("Must be a whole number")
      .min(0, "Enter a number between 0 and 60")
      .max(60, "Enter a number between 0 and 60")
      .nullable()
      .optional(),
    skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    techStack: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    socialLinks: z.array(socialLinkSchema).max(10).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  })
  .refine(
    (data) =>
      data.socialLinks === undefined ||
      new Set(data.socialLinks.map((link) => link.platform)).size ===
        data.socialLinks.length,
    { message: "Each platform may appear only once", path: ["socialLinks"] },
  );

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Standalone username change, for clients that separate it from the form. */
export const updateUsernameSchema = z.object({ username: usernameSchema });
export type UpdateUsernameInput = z.infer<typeof updateUsernameSchema>;

/**
 * Path parameter. Validated against the same charset as a real username so a
 * malformed handle is a 422 rather than a database round trip.
 */
export const usernameParamSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username"),
});
export type UsernameParam = z.infer<typeof usernameParamSchema>;

/**
 * Privacy settings. `twoFactorEnabled` is deliberately absent: it is read
 * through this endpoint but only *written* by the Phase 3 enrollment flow,
 * which requires a verified TOTP code. Accepting it here would let a client
 * claim 2FA without ever proving it holds the authenticator.
 */
export const updateSettingsSchema = z
  .object({
    profileVisibility: z.enum(ProfileVisibility).optional(),
    showEmailOnProfile: z.boolean().optional(),
    whoCanMessage: z.enum(MessagePermission).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one setting to update",
  });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

/**
 * One row of the Settings → Notifications matrix. Matches the frontend's
 * `updateNotificationPreference(type, channel, value)` call shape.
 */
export const updateNotificationPreferenceSchema = z
  .object({
    type: z.enum(NotificationType),
    inApp: z.boolean().optional(),
    email: z.boolean().optional(),
  })
  .refine((data) => data.inApp !== undefined || data.email !== undefined, {
    message: "Provide inApp or email",
  });

export type UpdateNotificationPreferenceInput = z.infer<
  typeof updateNotificationPreferenceSchema
>;

export { RESERVED_USERNAMES };
