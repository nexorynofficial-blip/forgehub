import { AuthShell } from "@/components/auth/auth-shell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content">
      <AuthShell>{children}</AuthShell>
    </main>
  );
}
