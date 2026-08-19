"use client";

import { useState } from "react";
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

  return (
    <header className="glass sticky top-0 z-40 w-full">
      <Container className="flex h-16 items-center justify-between">
        <Logo />

        <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {link.label}
            </a>
          ))}
        </nav>

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
      </Container>
    </header>
  );
}
