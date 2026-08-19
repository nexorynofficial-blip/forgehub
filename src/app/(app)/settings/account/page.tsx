import type { Metadata } from "next";

import { AccountForm } from "@/components/settings/account-form";

export const metadata: Metadata = { title: "Account settings" };

export default function AccountSettingsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Account</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Manage your profile, password, and account.
      </p>
      <div className="mt-6">
        <AccountForm />
      </div>
    </div>
  );
}
