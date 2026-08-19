# ForgeHub Design System

Implements `UI_UX.md`. All tokens live in `src/app/globals.css` as CSS custom
properties, mapped to Tailwind v4 utilities via `@theme inline`.

## Color palette

| Token          | Hex (from UI_UX.md §3) | Usage                             |
| -------------- | ---------------------- | --------------------------------- |
| `--background` | `#09090B`              | Page background                   |
| `--surface`    | `#111214`              | Sunken surfaces (inputs, sidebar) |
| `--card`       | `#18181B`              | Floating cards                    |
| `--primary`    | `#7C5CFF`              | Brand accent, primary actions     |
| `--secondary`  | `#00D4FF`              | Secondary accent                  |
| `--accent`     | `#FFB800`              | Tertiary/highlight accent         |
| `--success`    | `#16C784`              | Positive state                    |
| `--danger`     | `#FF5A5A`              | Destructive/error state           |

Every accent above is a fill color used behind text (buttons, badges), so
each needed a foreground pairing UI_UX.md doesn't specify. Computed WCAG
contrast ratios (relative luminance method):

| Fill                | vs. white text                | vs. near-black (`#0A0A0B`) text | Choice     |
| ------------------- | ----------------------------- | ------------------------------- | ---------- |
| Primary `#7C5CFF`   | 4.34:1 (fails AA normal text) | 4.60:1 (passes)                 | near-black |
| Danger `#FF5A5A`    | 3.06:1 (fails)                | 6.53:1 (passes)                 | near-black |
| Secondary `#00D4FF` | —                             | 11.30:1 (passes)                | near-black |
| Accent `#FFB800`    | —                             | 11.53:1 (passes)                | near-black |
| Success `#16C784`   | —                             | 9.10:1 (passes)                 | near-black |

Every `*-foreground` token therefore resolves to `--on-brand: #0A0A0B`
instead of white — this is the one deliberate deviation from "obvious"
choices, and it's a foreground pairing, not a change to any spec'd hex.
`--foreground` (body text, `#FAFAFA`) and `--muted-foreground` (`#A1A1AA`)
against `--background` are 15:1+ and 7.84:1 respectively — both comfortably
pass.

## Typography

UI_UX.md §4 names Inter, Space Grotesk, and Satoshi without assigning roles.
This project maps them:

| Token            | Family                                               | Role                         |
| ---------------- | ---------------------------------------------------- | ---------------------------- |
| `--font-sans`    | Inter                                                | Body copy, forms, UI chrome  |
| `--font-display` | Space Grotesk                                        | Headings, stat numbers, nav  |
| `--font-accent`  | Satoshi (falls back to Space Grotesk until licensed) | Hero/marketing emphasis only |

Inter and Space Grotesk load via `next/font/google` (self-hosted at build
time). Satoshi isn't on Google Fonts — see `public/fonts/satoshi/README.md`.

## Shape & elevation

- `--radius-lg: 24px` — UI_UX.md §2 "Rounded 24px corners"; applied to cards
  and dialogs (`rounded-lg` Tailwind utility, remapped to this value).
- `--radius-sm` / `--radius-md` — smaller controls (inputs, menu items).
- `--shadow-soft`, `--shadow-floating`, `--shadow-glow-primary` — UI_UX.md §2
  "Soft Shadows", "Floating Cards".

## Glassmorphism

`.glass` / `.glass-strong` utility classes (blur + saturate + translucent
fill + hairline border) implement UI_UX.md §2's glassmorphism requirement.
Used on Dialog, DropdownMenu, Select, Popover, and Toast surfaces.

## Motion vocabulary

See `docs/ARCHITECTURE.md` §6 for the Framer Motion / GSAP / Three.js split.
Overlay open/close animation (`.animate-forge-pop`, `.animate-forge-fade`)
is implemented as plain CSS keyframes keyed off Radix's `data-state`
attribute rather than the `tailwindcss-animate` plugin, since that plugin
isn't part of the installed stack.

## Component inventory

Button, Card, Badge, Avatar, Input, Textarea, Label, Switch, Tabs, Tooltip,
Dialog, DropdownMenu, Select, Popover, ScrollArea, Separator, Skeleton,
Toast/Toaster, Checkbox, HoverCard — all in `src/components/ui/`, all built
on Radix UI primitives for accessibility, styled with Tailwind +
`class-variance-authority` variants.
