import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 pt-8 pb-8 lg:flex-row">
      <SettingsNav />
      <div className="max-w-2xl min-w-0 flex-1">{children}</div>
    </div>
  );
}
