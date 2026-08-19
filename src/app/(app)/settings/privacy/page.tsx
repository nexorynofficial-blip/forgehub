import type { Metadata } from "next";

import { PrivacyForm } from "@/components/settings/privacy-form";

export const metadata: Metadata = { title: "Privacy settings" };

export default function PrivacySettingsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Privacy</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Control who can see and contact you.
      </p>
      <div className="mt-6">
        <PrivacyForm />
      </div>
    </div>
  );
}
