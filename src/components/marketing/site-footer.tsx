import Link from "next/link";

import { routes } from "@/lib/routes";
import { Container } from "@/components/layout/container";

const FOOTER_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#demo", label: "Live demo" },
  { href: "#communities", label: "Communities" },
  { href: "#testimonials", label: "Testimonials" },
  { href: routes.auth.login, label: "Sign in" },
  { href: routes.auth.signup, label: "Get started" },
];

export function SiteFooter() {
  return (
    <footer className="border-border border-t">
      <Container className="flex flex-col items-center gap-6 py-12 text-center sm:flex-row sm:justify-between sm:text-left">
        <div>
          <p className="font-display text-base font-semibold tracking-tight">
            Forge<span className="gradient-text-brand">Hub</span>
          </p>
          <p className="text-muted-foreground mt-1 text-sm">Build in public. Together.</p>
        </div>

        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
        >
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <p className="text-muted-foreground text-xs">
          © {new Date().getFullYear()} ForgeHub. All rights reserved.
        </p>
      </Container>
    </footer>
  );
}
