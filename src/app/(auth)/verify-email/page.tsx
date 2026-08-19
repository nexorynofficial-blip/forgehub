import type { Metadata } from "next";

import { VerifyEmailPanel } from "./verify-email-panel";

export const metadata: Metadata = { title: "Verify your email" };

interface VerifyEmailPageProps {
  searchParams: Promise<{ email?: string }>;
}

export default async function VerifyEmailPage({ searchParams }: VerifyEmailPageProps) {
  const { email } = await searchParams;
  return <VerifyEmailPanel email={email} />;
}
