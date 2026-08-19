import type { Metadata } from "next";

import { AppearanceForm } from "@/components/settings/appearance-form";

export const metadata: Metadata = { title: "Appearance settings" };

export default function AppearanceSettingsPage() {
  return (
    <div>
      <h1 className="font-display text-2xl font-semibold tracking-tight">Appearance</h1>
      <p className="text-muted-foreground mt-1 text-sm">Choose how ForgeHub looks.</p>
      <div className="mt-6">
        <AppearanceForm />
      </div>
    </div>
  );
}
