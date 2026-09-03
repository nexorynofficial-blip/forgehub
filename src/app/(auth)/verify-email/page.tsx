import type { Metadata } from "next";

import { VerifyEmailPanel } from "./verify-email-panel";

export const metadata: Metadata = { title: "Verify your email" };

interface VerifyEmailPageProps {
  searchParams: Promise<{ email?: string; token?: string }>;
}

/**
 * Two arrivals share this route.
 *
 * Sign-up sends the user here with `?email=` to say "check your inbox". The
 * emailed link then returns them with `?token=` — the backend builds
 * `APP_URL/verify-email?token=…` in `EmailService.sendVerificationEmail` — and
 * that token is what actually verifies the address. The panel branches on
 * which one it was given.
 */
export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const { email, token } = await searchParams;
  return <VerifyEmailPanel email={email} token={token} />;
}
