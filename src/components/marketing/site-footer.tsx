import Link from "next/link";

import { routes } from "@/lib/routes";
import { Container } from "@/components/layout/container";
import { GitHubIcon } from "@/components/auth/oauth-icons";

/**
 * The site footer.
 *
 * The previous version was one flex row — wordmark, six links, copyright —
 * about 100px tall. It technically existed, but at that height directly under
 * a full-bleed CTA card it read as page padding rather than as a footer, which
 * is why it did not register as one.
 *
 * Grouped into named columns instead, because the grouping is the information:
 * a visitor scanning the bottom of a page is looking for a particular *kind*
 * of thing — a part of the product, a way in, a way to get in touch — and
 * headed columns answer that where a flat list of six links does not.
 *
 * Every link resolves. Nothing here points at a page that does not exist: the
 * columns are short because the product is young, and a footer padded out with
 * dead links to "Careers" and "Changelog" is the exact filler that makes a
 * young product look like a template.
 */

interface FooterColumn {
  heading: string;
  links: { href: string; label: string }[];
}

const COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { href: "#how-it-works", label: "How it works" },
      { href: "#features", label: "Features" },
      { href: "#demo", label: "Live demo" },
      { href: "#communities", label: "Communities" },
      { href: "#testimonials", label: "Testimonials" },
      { href: "#faq", label: "FAQ" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { href: routes.auth.signup, label: "Create an account" },
      { href: routes.auth.login, label: "Sign in" },
      { href: routes.auth.forgotPassword, label: "Reset your password" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-border relative border-t">
      <Container className="py-14">
        <div className="flex flex-col gap-10 lg:flex-row lg:justify-between">
          {/* The brand column carries the one-line pitch, so the footer still
              says what the product is to someone who scrolled past the hero. */}
          <div className="max-w-xs">
            <p className="font-display text-lg font-semibold tracking-tight">
              Forge<span className="gradient-text-brand">Hub</span>
            </p>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Where developers, designers, and founders build in public — sharing
              progress, finding collaborators, and shipping out loud.
            </p>

            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="ForgeHub on GitHub"
              className="text-muted-foreground hover:text-foreground border-border focus-visible:ring-ring mt-5 inline-flex size-9 items-center justify-center rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <GitHubIcon className="size-4" />
            </a>
          </div>

          <div className="grid grid-cols-2 gap-x-12 gap-y-8 sm:gap-x-20">
            {COLUMNS.map((column) => (
              <nav key={column.heading} aria-label={column.heading}>
                <h2 className="text-foreground text-xs font-semibold tracking-[0.14em] uppercase">
                  {column.heading}
                </h2>
                <ul className="mt-4 flex flex-col gap-3">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="border-border mt-12 flex flex-col items-center justify-between gap-3 border-t pt-6 sm:flex-row">
          <p className="text-muted-foreground text-xs">
            © {new Date().getFullYear()} ForgeHub. All rights reserved.
          </p>
          <p className="text-muted-foreground/70 text-xs">
            Built in public, like everything else here.
          </p>
        </div>
      </Container>
    </footer>
  );
}
