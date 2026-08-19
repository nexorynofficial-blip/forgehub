"use client";

import { Check, Laptop, Moon, Sun } from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", icon: Moon, available: true },
  { value: "light", label: "Light", icon: Sun, available: false },
  { value: "system", label: "System", icon: Laptop, available: false },
] as const;

/** UI_UX.md §2 "Dark First" — no light-theme token values exist anywhere in
 * UI_UX.md §3's color palette, so Light/System are shown as genuinely
 * disabled rather than wired to a broken/unstyled theme. See
 * docs/ASSUMPTIONS.md (Phase 10). */
export function AppearanceForm() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Theme</CardTitle>
        <CardDescription>Choose how ForgeHub looks on your device.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-3">
          {THEME_OPTIONS.map((option) => (
            <div
              key={option.value}
              aria-current={option.value === "dark" ? "true" : undefined}
              className={cn(
                "border-border-strong relative flex flex-col items-center gap-2 rounded-lg border p-5 text-center",
                option.value === "dark" ? "border-primary bg-primary/5" : "opacity-50",
              )}
            >
              {option.value === "dark" && (
                <span className="bg-primary text-primary-foreground absolute top-2 right-2 flex size-5 items-center justify-center rounded-full">
                  <Check className="size-3" />
                </span>
              )}
              <option.icon className="size-6" />
              <span className="text-sm font-medium">{option.label}</span>
              {!option.available && (
                <Badge variant="outline" className="text-[10px]">
                  Coming soon
                </Badge>
              )}
            </div>
          ))}
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          ForgeHub is dark-first — light and system themes are on the roadmap.
        </p>
      </CardContent>
    </Card>
  );
}
