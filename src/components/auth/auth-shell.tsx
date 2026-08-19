import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { routes } from "@/lib/routes";
import { BrandPanel } from "@/components/auth/brand-panel";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <BrandPanel />

      <div className="relative flex flex-col justify-center px-6 py-16 sm:px-12">
        <Link
          href={routes.home}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-6 left-6 inline-flex items-center gap-1.5 rounded-sm text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none sm:left-12"
        >
          <ArrowLeft className="size-4" />
          Home
        </Link>

        <div className="mx-auto w-full max-w-sm">
          <Link
            href={routes.home}
            className="font-display focus-visible:ring-ring mb-10 block rounded-sm text-center text-lg font-semibold tracking-tight focus-visible:ring-2 focus-visible:outline-none lg:hidden"
          >
            Forge<span className="gradient-text-brand">Hub</span>
          </Link>
          {children}
        </div>
      </div>
    </div>
  );
}
