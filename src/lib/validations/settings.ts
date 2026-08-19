import { z } from "zod";

import { email, password } from "@/lib/validations/auth";

const optionalUrl = z
  .string()
  .trim()
  .url("Enter a valid URL")
  .optional()
  .or(z.literal(""));

export const accountSchema = z.object({
  displayName: z.string().trim().min(2, "Must be at least 2 characters"),
  username: z
    .string()
    .trim()
    .min(3, "Must be at least 3 characters")
    .regex(/^[a-z0-9._]+$/i, "Letters, numbers, dots, and underscores only"),
  email,
  bio: z.string().max(280, "Keep it under 280 characters"),
  experienceYears: z
    .string()
    .refine((value) => value === "" || (Number(value) >= 0 && Number(value) <= 60), {
      message: "Enter a number between 0 and 60",
    }),
  githubUrl: optionalUrl,
  xUrl: optionalUrl,
  skills: z.string(),
  techStack: z.string(),
});
export type AccountValues = z.infer<typeof accountSchema>;

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
export type ChangePasswordValues = z.infer<typeof changePasswordSchema>;
