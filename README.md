# ForgeHub

The social platform for builders, founders, designers, and developers to
build in public, gain followers, and recruit collaborators. See `PRD.md`,
`TRD.md`, and `UI_UX.md` at the repo root for the product/technical/design
specs, and `ForgeHub_ClaudeCode_Prompts/ForgeHub_ClaudeCode_Prompts/FRONTEND/`
for the phase-by-phase build plan this frontend follows.

**Status: all 12 phases complete.** Every route in the Phase 01 plan exists
except `/projects/new` (Phase 07 scoped that phase to the project showcase
page, not creation — see `docs/ASSUMPTIONS.md`). This is a frontend-only
build: every network call in `src/lib/services/` is a mocked `Promise` over
fixture data in `src/lib/mock/`, standing in for the backend described in
`TRD.md` until one exists. The demo user (Ava Whitfield) is a Platform Admin,
so the Admin section is reachable — `AdminGuard` enforces the same RBAC role
check at the route level, not just the nav's visibility check.

## What's built

- **Marketing** — landing page with a Three.js hero scene (GSAP
  ScrollTrigger parallax on scroll), features, testimonials, live activity
  feed, communities teaser, CTA.
- **Auth** — login, signup, forgot-password, email verification, 2FA, all
  Zod + react-hook-form, OAuth buttons (visual-only, no provider configured).
- **Dashboard** — stats, trending projects, leaderboard, upcoming events,
  quick messages, activity feed.
- **Profile** — banner, contribution heatmap, pinned projects, achievements,
  followers, activity timeline.
- **Feed** — composer, six filter/sort modes, infinite scroll, comments,
  poll voting, code blocks, author hover cards.
- **Project page** — roadmap/milestones, gallery (lightbox), team, updates,
  discussion thread.
- **Communities** — discovery grid with search/category filters, community
  page (rules, events, members, pinned posts).
- **Messages** — Discord-style two-pane shell, typing indicator, read
  receipts, emoji picker, file-attachment chips.
- **Settings** — account, appearance (dark-only, documented), privacy,
  notifications (per-type in-app/email matrix).
- **Admin** — RBAC-gated overview, reports queue (moderation actions),
  user management, analytics (hand-rolled SVG charts).

Full per-phase reasoning and every documented gap-filling decision live in
`docs/ASSUMPTIONS.md`; the architecture those decisions produced is in
`docs/ARCHITECTURE.md`.

## Stack

Next.js (App Router) · TypeScript · Tailwind CSS v4 · Framer Motion · GSAP ·
Three.js · React Query · Zustand · React Hook Form · Zod · Radix UI

See `docs/ASSUMPTIONS.md` ("Stack additions beyond TRD.md §1") for what was
added beyond `TRD.md`'s stack list and why.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Scripts

| Script                            | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `npm run dev`                     | Start the dev server                           |
| `npm run build`                   | Production build                               |
| `npm run start`                   | Serve the production build                     |
| `npm run lint`                    | ESLint                                         |
| `npm run typecheck`               | `tsc --noEmit`                                 |
| `npm run format` / `format:check` | Prettier (with Tailwind class sorting)         |
| `npm run analyze`                 | Production build with the bundle analyzer open |

## Docs

- `docs/ARCHITECTURE.md` — folder structure, component/route/layout
  hierarchy, and the animation/theme/responsive/a11y/performance/RBAC
  strategy, with a dedicated section per phase that introduced a new
  architectural pattern.
- `docs/DESIGN_SYSTEM.md` — color tokens (with contrast ratios),
  typography, shape, motion vocabulary.
- `docs/ASSUMPTIONS.md` — every gap the source docs left open and how it
  was resolved, organized by phase.

## Project structure

```
src/
  app/            Routes (App Router) — (marketing), (auth), (app) route groups
  components/
    ui/           Design-system primitives (Button, Card, Dialog, ...)
    motion/       Framer Motion wrappers
    three/        Three.js canvas infrastructure
    layout/       Container, Section
    marketing/    Landing page sections (header, hero, features, footer, ...)
    auth/         Auth shell, brand panel, OAuth buttons, password/OTP inputs
    app/          Dashboard shell: sidebar, topbar, notifications, bottom nav
    dashboard/    Dashboard widgets (stats, trending, leaderboard, events, ...)
    profile/      Profile banner, contribution heatmap, pinned projects, ...
    feed/         PostCard (all post types), composer, comments, poll voting
    project/      Hero, roadmap, gallery, team, updates, discussion
    communities/  Discovery grid + filters, hero, rules, events, members
    messages/     Discord-style two-pane messaging: list, thread, composer
    settings/     Account/appearance/privacy/notifications forms + nav
    admin/        AdminGuard (RBAC), overview stats, reports queue, users,
                  analytics charts (hand-rolled SVG — see docs/ASSUMPTIONS.md)
    shared/       Cross-feature composed widgets (e.g. AvatarStackDialog)
  lib/            utils, fonts, routes registry, gsap setup, site metadata,
                  mock data, services, Zod validations, rbac
  store/          Zustand stores
  providers/      App-wide provider tree
  hooks/          Cross-cutting hooks
  types/          Domain types mirroring TRD.md §4
docs/             ARCHITECTURE.md, DESIGN_SYSTEM.md, ASSUMPTIONS.md
```

Mock data (`src/lib/mock/`) and placeholder services (`src/lib/services/`)
stand in for the backend until it exists — every service function returns a
`Promise` so swapping in a real `fetch` later doesn't change call sites.

## SEO & metadata

Root metadata (`src/app/layout.tsx`) includes OpenGraph/Twitter tags backed
by a programmatically generated OG image (`src/app/opengraph-image.tsx`, via
`next/og`), plus `sitemap.ts` and `robots.ts` file-convention routes
(private `(app)` routes disallowed from indexing).

## Known gaps

- `/projects/new` (project creation) and `/communities/new` (community
  creation) aren't built — both are documented, deliberate scope
  exclusions (see `docs/ASSUMPTIONS.md`, Phases 07/08).
- No real backend, auth/session, or WebSocket layer — every "live" or
  persisted behavior (typing indicators, notifications, likes) is either
  polling-simulated or local component state. RBAC and form validation are
  fully real; they just have no server to also enforce them.
- Light theme is intentionally disabled (`forcedTheme="dark"`) — no light
  palette exists in the source design docs.
