import type { Metadata } from "next";

import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

interface ResetPasswordPageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Where the emailed reset link lands.
 *
 * The backend builds `APP_URL/reset-password?token=…` in
 * `EmailService.sendPasswordResetEmail`, so this route and that query
 * parameter are the contract — renaming either breaks every link already in
 * someone's inbox.
 */
export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { token } = await searchParams;
  return <ResetPasswordForm token={token} />;
}
