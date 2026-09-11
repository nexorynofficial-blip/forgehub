"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { Container } from "@/components/layout/container";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#demo", label: "Live demo" },
  { href: "#communities", label: "Communities" },
  { href: "#testimonials", label: "Testimonials" },
];

/** Module-scope so the effect below has a stable dependency. */
const NAV_SECTION_IDS = NAV_LINKS.map((link) => link.href.slice(1));

/**
 * Which section the reader is currently in.
 *
 * The band is the middle tenth of the viewport (`-45%` top, `-50%` bottom), so
 * "current" means *at the reading line*, not merely on screen — with a
 * full-height rootMargin two sections are visible at once for most of a scroll
 * and the highlight would flicker between them.
 */
function useActiveSection(): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sections = NAV_SECTION_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    if (sections.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Document order, so the resolution of an overlap is always the same
        // one rather than depending on which entry the callback saw last.
        setActive(NAV_SECTION_IDS.find((id) => visible.has(id)) ?? null);
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return active;
}

function Logo() {
  return (
    <Link
      href={routes.home}
      className="font-display focus-visible:ring-ring rounded-sm text-lg font-semibold tracking-tight focus-visible:ring-2 focus-visible:outline-none"
    >
      Forge<span className="gradient-text-brand">Hub</span>
    </Link>
  );
}

function AuthActions({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Button asChild variant="ghost">
        <Link href={routes.auth.login}>Sign in</Link>
      </Button>
      <Button asChild variant="primary">
        <Link href={routes.auth.signup}>Get started</Link>
      </Button>
    </div>
  );
}

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeSection = useActiveSection();

  return (
    /*
      `glass-strong` plus a bottom hairline, not `glass`. At 60% opacity the
      bar was transparent enough that cards scrolling beneath it read *through*
      the nav labels — two sets of text in the same pixels. A sticky header has
      to be opaque enough to be a surface.
    */
    <header className="glass-strong border-border sticky top-0 z-40 w-full border-x-0 border-t-0 border-b">
      {/*
        Laid out 1fr / auto / 1fr rather than with `justify-between`.
        Between-spacing centres the nav in whatever room its neighbours leave,
        and those neighbours are not the same width — the wordmark is ~80px,
        the two auth buttons ~229px — so the nav sat roughly 60px left of the
        page's centre line while the hero below it was centred properly. Equal
        flex on both flanks puts the nav on the true centre.
      */}
      <Container className="flex h-16 items-center gap-6">
        <div className="flex flex-1 items-center">
          <Logo />
        </div>

        {/*
          The links sit in a pill rather than floating loose in the bar. Even
          once truly centred they read as pushed toward the buttons, because
          the space either side of them is not equal (266px to the wordmark,
          118px to "Sign in") and loose words have no edges of their own to
          contradict that. Giving the group a boundary makes it an object that
          is visibly centred, and it matches how these links behave — they
          switch between parts of one page, so they should look like tabs.
        */}
        <nav
          aria-label="Primary"
          className="glass hidden items-center gap-1 rounded-full p-1 md:flex"
        >
          {NAV_LINKS.map((link) => {
            const isActive = activeSection === link.href.slice(1);
            return (
              <a
                key={link.href}
                href={link.href}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "focus-visible:ring-ring rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {link.label}
              </a>
            );
          })}
        </nav>

        <div className="flex flex-1 items-center justify-end">
          <AuthActions className="hidden md:flex" />

          <Popover open={mobileOpen} onOpenChange={setMobileOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={mobileOpen ? "Close menu" : "Open menu"}
              >
                {mobileOpen ? <X /> : <Menu />}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={12} className="w-64 md:hidden">
              <nav aria-label="Mobile" className="flex flex-col gap-1">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className="hover:bg-muted rounded-md px-2 py-2 text-sm font-medium transition-colors"
                  >
                    {link.label}
                  </a>
                ))}
              </nav>
              <div className="bg-border my-3 h-px" />
              <AuthActions className="flex-col items-stretch [&>a]:w-full" />
            </PopoverContent>
          </Popover>
        </div>
      </Container>
    </header>
  );
}
