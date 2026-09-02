import type { Metadata } from "next";

import { RedirectIfAuthenticated } from "@/components/auth/auth-gate";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <RedirectIfAuthenticated>
      <SignupForm />
    </RedirectIfAuthenticated>
  );
}
