# ForgeHub Frontend Architecture

This is the implementation plan produced during Phase 01 (Project Setup),
kept as living documentation and updated as each phase landed. All 12
phases are now complete. It records the folder structure, component/
route/layout hierarchy, and the animation/theme/responsive/accessibility/
performance strategy, including the final-polish pass (§18) done once every
feature phase had shipped.

Source of truth: `PRD.md`, `TRD.md`, `UI_UX.md` at the repo root, plus the
per-phase briefs in `ForgeHub_ClaudeCode_Prompts/ForgeHub_ClaudeCode_Prompts/FRONTEND/`.
Where those documents were silent, this file's companion `docs/ASSUMPTIONS.md`
records the decision made and why.

## 1. Folder structure

```
src/
  app/                      # Next.js App Router — routes only, no business logic
    layout.tsx              # Root layout: fonts, metadata, providers, skip link (no <main>)
    globals.css             # Design tokens (Tailwind v4 @theme) + base/utility layers
    (marketing)/            # Public routes — Phase 02 (landing page)
      layout.tsx             # SiteHeader + <main> + SiteFooter
      page.tsx                # "/" — the real landing page
    (auth)/                 # Phase 03: login/signup/forgot-password/verify-email/2fa
      layout.tsx             # Centered single-column shell, no nav
    (app)/                  # Phase 04: authenticated shell (sidebar/topbar/bottom nav)
      layout.tsx             # AppSidebar + AppTopbar + MobileBottomNav wrapping every route
      not-found.tsx           # Phase 05: in-shell 404 (sidebar/topbar stay visible)
      dashboard/              # "/dashboard" — stats, feed, trending, leaderboard, events, chat
      profile/[username]/     # Phase 05: banner, heatmap, pinned projects, achievements, timeline
      feed/                   # Phase 06: "/feed" — composer, filters, infinite-scroll post list
      projects/[projectId]/   # Phase 07: hero, roadmap, gallery, team, updates, discussion
      communities/            # Phase 08: "/communities" discovery grid + filters
        [communityId]/         # hero, rules, events, members, pinned posts
      messages/               # Phase 09: own layout.tsx (two-pane shell, see §14)
        [conversationId]/      # active thread; "/messages" alone shows an empty state
      settings/               # Phase 10: own layout.tsx (SettingsNav + content column)
        account/, appearance/, privacy/, notifications/  # page.tsx: title + a form
        page.tsx                # bare "/settings" redirects to /settings/account
      admin/                  # Phase 11: own layout.tsx (AdminGuard + AdminNav)
        page.tsx, reports/, users/, analytics/  # RBAC-gated, see §16
    not-found.tsx            # Phase 05: standalone 404 for routes outside any shell
  components/
    ui/                     # Design-system primitives (Button, Card, Dialog, ...)
    motion/                 # Framer Motion wrappers (FadeIn, RevealOnScroll, AnimatedCounter, ...)
    three/                  # Three.js canvas infrastructure (lazy, SSR-safe, client-only boundary)
    layout/                 # Container, Section — cross-page structural primitives
    marketing/              # Phase 02: SiteHeader, SiteFooter, hero/features/testimonials/
                             # communities/CTA sections, hero-scene (Three.js content)
    auth/                   # Phase 03: AuthShell, BrandPanel, OAuthButtons, PasswordInput,
                             # PasswordStrengthMeter, OtpInput, AuthHeading
    app/                    # Phase 04: AppSidebar, MobileSidebarDrawer, AppTopbar, UserMenu,
                             # NotificationsPanel, MobileBottomNav, NavItem — the app shell
    dashboard/               # Phase 04: WelcomeHeader, StatsGrid, TrendingProjectsWidget,
                             # LeaderboardWidget, UpcomingEventsWidget, QuickMessagesWidget,
                             # ActivityFeedWidget (reuses marketing/LiveActivityFeed)
    profile/                 # Phase 05: ProfileBanner, ContributionHeatmap,
                             # PinnedProjectsSection, AchievementsSection, FollowersWidget,
                             # ProfileTimeline, SocialLinkIcon
    feed/                    # Phase 06: FeedList, PostCard, PostComposer, FeedFilters,
                             # CommentSection, PostTypeContent, CodeBlock, PollVoter,
                             # AuthorHoverCard, NewPostsPill
    project/                 # Phase 07: ProjectHero, ProjectMetricsBar, ProjectRoadmap,
                             # ProjectGallery, ProjectTeam, ProjectUpdates, ProjectDiscussion
    communities/              # Phase 08: CommunityCard, CommunityFilters, CommunityDiscovery,
                             # CommunityHero, CommunityRules, CommunityEvents,
                             # CommunityMembers, CommunityPinnedPosts (reuses feed/PostCard)
    shared/                  # Phase 08: cross-feature composed widgets that aren't design-
                             # system primitives (components/ui) but are reused by 2+
                             # features — e.g. AvatarStackDialog (profile + communities)
    messages/                 # Phase 09: MessagesShell, ConversationList(Item),
                             # MessageThread, MessageBubble, MessageComposer,
                             # EmojiPicker, TypingIndicator, MessagesEmptyState
    settings/                 # Phase 10: SettingsNav, AccountForm, AppearanceForm,
                             # PrivacyForm, NotificationsForm
    admin/                   # Phase 11: AdminGuard, AdminNav, OverviewStats,
                             # ReportsList/ReportRow, UsersList/UserRow,
                             # WeeklySignupsChart, ReportsByReasonChart
  lib/
    utils.ts                # cn() class merge helper
    fonts.ts                # next/font definitions
    format.ts                # formatRelativeTime, formatCompactNumber
    routes.ts               # Typed route registry (single source of truth for paths)
    site-config.ts           # Phase 12: name/title/description/url for metadata + OG image
    gsap.ts                 # GSAP plugin registration (ScrollTrigger) — used by the
                             # landing hero's scroll parallax (Phase 12, see §18)
    mock/                   # Fixture data, one file per domain entity
    services/                # Async functions future phases call; mock now, fetch later
    validations/             # Phase 03: Zod schemas (auth.ts — login/signup/forgot-password/2fa)
                             # Phase 10: settings.ts (account fields, change password —
                             # imports auth.ts's email/password rules rather than redefining them)
    project-meta.ts          # Phase 07: shared status/funding badge labels (profile + project page)
    messaging.ts             # Phase 09: getConversationLabel (thread header + list item)
    rbac.ts                  # Phase 11: isAdminRole (nav visibility + AdminGuard, one source)
  store/                    # Zustand stores for client-only UI state
  providers/                # AppProviders — React Query, Theme, MotionConfig, Tooltip, Toast
  hooks/                    # Cross-cutting hooks (media query, reduced motion, ...)
  types/                    # Domain types mirroring TRD.md §4's entity list
docs/                       # This file, DESIGN_SYSTEM.md, ASSUMPTIONS.md
public/
  fonts/satoshi/            # Drop-in point for the licensed Satoshi font file
```

Feature-based folders (`components/feed`, `components/profile`, etc.) are
created by the phase that needs them, not pre-scaffolded here — see
`docs/ASSUMPTIONS.md` on why Phase 01 stays infrastructure-only.

## 2. Component hierarchy

```
RootLayout (server)
  AppProviders (client: QueryClient, ThemeProvider, MotionConfig, TooltipProvider, Toaster)
    <route segment>
      components/layout (Container, Section)
        components/ui primitives (Button, Card, Dialog, ...)
          components/motion wrappers (FadeIn, RevealOnScroll, MagneticButton)
            components/three (SceneCanvas, lazy) — only where a scene is needed
```

`components/ui/*` are the leaf primitives: no data fetching, no route
awareness, styled purely from design tokens. `components/<feature>/*`
(Phase 02+) compose them into page sections and _do_ know about routes and
data.

## 3. Route hierarchy (planned — see `src/lib/routes.ts`)

| Route                                                            | Phase | Group         |
| ---------------------------------------------------------------- | ----- | ------------- |
| `/`                                                              | 02    | `(marketing)` |
| `/login`, `/signup`, `/forgot-password`, `/verify-email`, `/2fa` | 03    | `(auth)`      |
| `/dashboard`                                                     | 04    | `(app)`       |
| `/profile/[username]`                                            | 05    | `(app)`       |
| `/feed`                                                          | 06    | `(app)`       |
| `/projects/[projectId]`, `/projects/new`                         | 07    | `(app)`       |
| `/communities`, `/communities/[communityId]`                     | 08    | `(app)`       |
| `/messages`, `/messages/[conversationId]`                        | 09    | `(app)`       |
| `/settings/*`                                                    | 10    | `(app)`       |
| `/admin/*`                                                       | 11    | `(app)`       |

Route groups partition layouts (marketing chrome vs. auth shell vs.
authenticated sidebar shell) without affecting URLs. `(marketing)` (Phase 02),
`(auth)` (Phase 03), and `(app)` (Phase 04) all exist today; `/dashboard`
(Phase 04), `/profile/[username]` (Phase 05), `/feed` (Phase 06),
`/projects/[projectId]` (Phase 07), `/communities` +
`/communities/[communityId]` (Phase 08), `/messages` +
`/messages/[conversationId]` (Phase 09), all four `/settings/*` pages
(Phase 10), and all four `/admin/*` pages (Phase 11) are built inside
`(app)` — only `/projects/new` remains unbuilt, per `docs/ASSUMPTIONS.md`.

## 4. Layout hierarchy

- **Root layout** (`app/layout.tsx`): html/body shell, fonts, global providers,
  skip-to-content link. Applies to every route. Does _not_ render `<main>`
  itself — each route group's layout owns that, since marketing chrome
  (header+footer) and the future app shell (sidebar+topbar) wrap `<main>`
  differently.
- **`(marketing)` layout** (Phase 02): `SiteHeader`, then `<main id="main-content">`,
  then `SiteFooter`, wrapping every public page.
- **`(auth)` layout** (Phase 03): centered single-column shell, no nav.
- **`(app)` layout** (Phase 04): `AppSidebar` (persistent, `lg:` and up) +
  `AppTopbar` (search, notifications, messages, account menu) +
  `MobileBottomNav` (below `lg`), wrapping every authenticated route
  (dashboard, profile, feed, projects, communities, messages, settings,
  admin) — see §11 below.

## 5. Shared UI components (Phase 01 deliverable, extended per phase)

`components/ui/`: Button, Card (+Header/Title/Description/Content/Footer),
Badge, Avatar, Input, Textarea, Label, Switch, Tabs, Tooltip, Dialog,
DropdownMenu, Select, Popover, ScrollArea, Separator, Skeleton, Toast/Toaster,
Checkbox (Phase 03), HoverCard (Phase 06).

Built on Radix UI primitives (unstyled, accessible) + `class-variance-authority`
for variants + Tailwind for styling — the same pattern popularized by
shadcn/ui. Radix wasn't named in TRD.md's stack list; it's added because
building accessible focus-trapped modals/menus from scratch is the highest-
risk way to fail the WCAG AA requirement. See `docs/ASSUMPTIONS.md`.

## 6. Animation strategy

Three engines, each with a defined job (TRD.md §1, UI_UX.md §5):

- **Framer Motion** — component-level and layout animation: entrances
  (`FadeIn`), scroll reveals (`RevealOnScroll`, via `whileInView`), hover/tap
  states, magnetic buttons, shared-layout transitions. Wrapped once at the
  root in `MotionConfig reducedMotion="user"`, so every Framer animation in
  the app automatically no-ops under `prefers-reduced-motion` — components
  don't each re-check it.
- **GSAP** (`src/lib/gsap.ts`) — scroll-linked and timeline-driven work:
  pinning, parallax, complex multi-step sequences (landing hero, dashboard
  stat counters). Registered once via `registerGsap()`; components call it
  before touching `ScrollTrigger`.
- **Three.js** (`components/three/SceneCanvas`) — WebGL backgrounds. The
  canvas lifecycle (mount, resize, render loop, disposal) is generic;
  `createScene` plugs in actual content per page. Always loaded through the
  `ssr: false` dynamic wrapper in `components/three/index.ts`. Under reduced
  motion, it renders a single static frame instead of animating.
  `components/three/index.ts` itself is marked `"use client"` — Next.js
  rejects `next/dynamic({ ssr: false })` inside a Server Component, and any
  page composing a `createScene` callback into `<SceneCanvas>` must also be
  a Client Component (functions can't cross the server→client prop boundary
  unmarked). See `HeroSection` for the pattern.

All three read from the same `useReducedMotion` hook (`prefers-reduced-motion`
media query) so degrading motion is consistent app-wide rather than decided
per-library.

## 7. Theme system

CSS custom properties defined in `:root` (`app/globals.css`), mapped into
Tailwind v4 via `@theme inline` so tokens are usable as utilities
(`bg-primary`, `text-muted-foreground`, `rounded-lg`, etc.). Dark is the only
theme shipped now (UI_UX.md §2 "Dark First"); `next-themes` is already wired
with `attribute="data-theme"` so adding a light theme later is a CSS-values
change, not a re-plumb — see `docs/ASSUMPTIONS.md`.

## 8. Responsive strategy

Mobile-first Tailwind breakpoints (`sm`/`md`/`lg`/`xl`, defaults — UI_UX.md
gives no custom breakpoint values). `components/layout/Container` caps
content width and handles horizontal gutters everywhere so pages don't
redefine it. UI_UX.md §11 (bottom nav, FAB, swipe sheets) is implemented by
the `(app)` shell — see §11 below.

## 9. Accessibility strategy

- Radix primitives supply focus trapping, roving tabindex, and ARIA wiring
  for every interactive component.
- Global `:focus-visible` ring (`app/globals.css`) instead of per-component
  focus styles.
- Skip-to-content link, `<main id="main-content">` landmark.
- One global `prefers-reduced-motion` block disables all CSS animation/
  transition durations; Framer, GSAP, and Three.js each additionally check
  `useReducedMotion` for JS-driven motion.
- Color palette contrast-checked against WCAG AA — see
  `docs/DESIGN_SYSTEM.md` for the computed ratios and the foreground-pairing
  fix that was needed for the brand accents.

## 10. Form strategy

Every form (login, signup, forgot-password, 2FA) follows the same pattern:
a Zod schema in `lib/validations/`, wired via `@hookform/resolvers/zod` into
`react-hook-form`'s `useForm`. Native `<input>`-compatible fields use
`register()`; non-native fields (`Checkbox`, `OtpInput`) use `Controller`.
Submission calls the matching `lib/services/auth-service.ts` function —
today a simulated network delay, later a real `fetch` — and `isSubmitting`
from `formState` drives the button's loading spinner. Errors render inline
via `aria-invalid`/`aria-describedby`, not toasts; toasts are reserved for
submission outcomes.

## 11. App shell strategy (Phase 04)

`(app)/layout.tsx` composes three pieces, all in `components/app/`:

- **`AppSidebar`** — persistent at `lg:` and up (`lg:flex`, fixed 256px
  column). Nav items and the user footer card share one `SidebarNav`
  function so `AppSidebar` (static `<aside>`) and `MobileSidebarDrawer`
  (Framer Motion slide-in panel, `lg:hidden`) never drift out of sync.
  `MobileSidebarDrawer` is driven by `useUIStore`'s `isSidebarOpen` — the
  Phase 01 UI store anticipated exactly this — and locks body scroll via
  `useLockBodyScroll` while open.
- **`AppTopbar`** — sticky, `glass` surface. Hamburger (opens the mobile
  drawer, `lg:hidden`), a visual-only search input, `NotificationsPanel`
  (Popover-based, unread dot + mark-all-read), a messages icon linking to
  `/messages` with an unread badge, and `UserMenu` (DropdownMenu: profile,
  settings, mock sign-out).
- **`MobileBottomNav`** — fixed, `lg:hidden`, four primary destinations plus
  a centered floating-action button (`routes.newProject`). `<main>` carries
  `pb-24` on small viewports so scrolled content never sits under the fixed
  bar.

Every nav destination reads from `lib/routes.ts`; every sidebar link now
resolves to a real page — the incremental "this links somewhere that
doesn't exist yet" pattern that ran from Phase 02 through Phase 10 (each
phase linking ahead to routes its successors would build) is complete as
of Phase 11. Only the sidebar/FAB's `routes.newProject` link remains
unbuilt, per `docs/ASSUMPTIONS.md` (Phase 07).

## 12. Dynamic route data-fetching strategy (Phase 05)

Every data-fetching component so far (Phases 02–04) is a Client Component
calling a service through `useQuery`, even where a Server Component could
fetch instead — kept consistent so there's one data-fetching pattern in the
whole app. `/profile/[username]/page.tsx` is the first deliberate exception:
it's an `async` Server Component that resolves `params`, calls
`getUserByUsername` directly, and calls `notFound()` (from `next/navigation`)
when there's no match — because `notFound()` and per-route `generateMetadata`
(used here for a personalized `<title>`) both require server execution: a
Client Component can't do either. Everything below that boundary (heatmap,
timeline, pinned projects, followers) goes back to the normal client
`useQuery` pattern, taking the resolved `user` as a prop. Later phases with
their own slug/ID routes (Project Page, Community) should follow the same
split: resolve the primary entity server-side for `notFound()`/metadata,
fetch supplementary widget data client-side as usual.

`notFound()` renders the nearest `not-found.tsx` up the segment tree —
`(app)/not-found.tsx` (Phase 05) keeps `AppSidebar`/`AppTopbar` visible for
any bad `(app)` URL, not just profile; a root `app/not-found.tsx` handles
routes outside every route group.

`/projects/[projectId]/page.tsx` (Phase 07) and
`/communities/[communityId]/page.tsx` (Phase 08) both confirm the pattern:
same server-resolve-then-notFound shape, each matching its dynamic segment
against a `.slug` field (not `.id` — the params are named `projectId`/
`communityId` per the Phase 01 route plan, but resolve by slug for a
readable URL, same as `[username]` resolving by username rather than a
numeric id). Three dynamic routes now agree on this shape; it's the
established pattern for every slug/ID route still to come.

## 13. Feed pagination & optimistic-update strategy (Phase 06)

`FeedList` (`components/feed/`) is the app's first infinite-scroll surface:
`useInfiniteQuery` (`@tanstack/react-query`) keyed on `["feed", filter]`,
paired with `useIntersectionObserver` (`hooks/use-intersection-observer.ts`)
watching a sentinel `<div>` at the list's end — when it scrolls into view,
`fetchNextPage()` fires. `feed-service.ts`'s `getFeedPage` returns the
shared `Paginated<T>` shape (`types/common.ts`, defined in Phase 01, unused
until now) with a string-index cursor over a sorted-in-memory mock pool.

Likes and poll votes are local component state (`PostCard`, `PollVoter`) —
no server round trip, so no cache to update. Comments and new posts _do_
need to persist across the component tree without a refetch, so both use
`queryClient.setQueryData` directly: `CommentSection` appends to the
`["comments", postId]` cache, `PostComposer` prepends into
`["feed", activeFilter]`'s first page via `InfiniteData`'s `pages` array.
This is the app's first hand-rolled optimistic update — every earlier
mutation (login, follow, mark-all-read) either didn't need the result
reflected elsewhere or just called `invalidateQueries`.

## 14. Messaging shell strategy (Phase 09)

`(app)/messages/` is the first section with its own nested `layout.tsx`
rather than relying purely on `(app)/layout.tsx`. `MessagesShell`
(`components/messages/`) renders a responsive two-pane Discord-style
layout — `ConversationList` (left) and `{children}` (right, either
`MessagesEmptyState` at `/messages` or `MessageThread` at
`/messages/[conversationId]`) — inside a fixed-height container
(`h-[70vh] lg:h-[75vh]`) so each pane scrolls independently instead of the
whole page scrolling. Below `lg`, only one pane shows at a time; since a
layout can't know which leaf route matched, `MessagesShell` is a Client
Component that checks `usePathname() !== routes.messages` to decide which
pane gets `hidden lg:block`. `MessageThread`'s header carries a
`lg:hidden` back button to `/messages` for the reverse direction.

Real-time behavior (TRD.md §6 Socket.IO — typing indicators, live
delivery) has no actual socket: `checkTypingIndicator` and the dashboard/
feed's earlier polling tricks (Phase 04's notification check, Phase 06's
`checkForNewPosts`) all use the same pattern — a `useQuery` with
`refetchInterval` standing in for a server push. Sending a message follows
Phase 06's optimistic-update precedent (`queryClient.setQueryData`) rather
than a refetch.

## 15. Interactive-list reactivity strategy (Phase 10)

A real bug surfaced while building Settings, worth recording as a load-
bearing pattern rather than a one-off fix: `NotificationsForm` (a
`.map()`-generated grid of `Switch`es reading `useQuery` data) and
`NotificationsPanel` (a `.map()`-generated notification list, same shape)
both failed to visually update after their mutation handlers ran —
`queryClient.invalidateQueries()` _and_ explicit `queryClient.setQueryData()`
both provably updated the cache (confirmed via `getQueryData`/
`getQueryState` — correct data, `dataUpdateCount` incremented, `status:
"success"`) but the subscribing component never re-rendered. A plain
`useState` counter in the exact same component re-rendered correctly on
every click, and a structurally simpler form (`PrivacyForm` — same
services, same invalidate-on-mutate pattern, but no `.map()` over the
interactive elements) worked fine. The common factor in both broken cases:
a `.map()`-generated list of interactive elements whose checked/rendered
state is read directly from `useQuery`'s `data`.

Root cause wasn't pinned down further (a React 19 / React Query v5 /
Turbopack-dev-mode interaction is suspected, not confirmed) — instead,
both components were changed to the pattern already proven everywhere else
in this app for instant-feedback interactive elements (`PostCard`'s like
button, `ProfileBanner`'s follow toggle, `PollVoter`): an outer component
fetches via `useQuery` and renders a skeleton until data resolves; once
resolved, an **inner component mounts once** with that data as a
`useState` initial value (not synced via `useEffect`, which
`react-hooks/set-state-in-effect` correctly flags), and every toggle
updates that local state directly, firing the service call
fire-and-forget for the mock "persistence" layer. **New rule for any
future `.map()`-generated list of interactive controls bound to server
state: default to this local-state pattern, not query-cache-driven
`checked`/`value` props** — don't re-litigate the query-reactivity approach
per component.

## 16. RBAC and Admin strategy (Phase 11)

TRD.md §7 lists RBAC as a security requirement. Phase 04 only gated the
sidebar's Admin _link_ (`isAdminRole` check, hiding it for non-admin
roles); Phase 11 adds the second half — `AdminGuard`
(`components/admin/admin-guard.tsx`) wraps `(app)/admin/layout.tsx` and
re-checks the same role client-side, rendering an "Access denied" state
for non-admins instead of the page content. `isAdminRole` was extracted to
`lib/rbac.ts` specifically so the nav check and the route check can't drift
onto two different role lists. Like every other guard in this mock build,
it's enforced client-side only — there's no session/auth backend to check
it server-side (consistent with `docs/ASSUMPTIONS.md` throughout: no
phase implements real authentication). `mockCurrentUser`'s role was
changed to `platform_admin` in this phase specifically so the section is
reachable in the demo — see `docs/ASSUMPTIONS.md` (Phase 11).

Analytics charts (`WeeklySignupsChart`, `ReportsByReasonChart`) are
hand-rolled SVG, not a charting library — both are single-series bar
charts (one brand hue, no legend needed per the dataviz skill's guidance
for 1–3 series), which don't justify a new dependency. Contrast of the
mark color (`--primary`) against the card/surface backgrounds was computed
directly (WCAG relative-luminance formula) rather than assumed: 4.08:1 and
4.31:1, both clearing the ≥3:1 non-text-contrast threshold.

## 17. Performance strategy

- `next/font` self-hosts Inter and Space Grotesk at build time (no runtime
  Google Fonts request, no layout shift from a late font swap).
- Three.js is code-split via `next/dynamic({ ssr: false })` so it never
  ships in the server bundle and only loads on pages that render a scene.
- `next.config.ts` restricts `next/image` formats to avif/webp and
  tree-shakes `lucide-react` imports via `optimizePackageImports`.
- `npm run analyze` wraps the build with `@next/bundle-analyzer` for
  ongoing bundle-size auditing.
- App Router route segments code-split automatically per route.

## 18. Final Polish (Phase 12)

With every feature phase (02–11) shipped, this phase audited the whole app
rather than adding a new section — six passes, each recorded here so the
reasoning isn't lost:

**Dead code.** Cross-referenced every file in `lib/`, `hooks/`, `store/`,
`providers/`, and `types/` against its import sites app-wide.
`hooks/use-mounted.ts` was genuinely unused (deleted) — every SSR-unsafe
case (Three.js) was already handled via `next/dynamic({ ssr: false })`, so
the hook never had a real caller. Everything else that looked unused on a
first pass wasn't: barrel-exported `types/*` files are consumed through
`types/index.ts`, and `components/three/scene-canvas.tsx` is only ever
reached through the dynamic import in `components/three/index.ts`.

**Mandated-but-unused dependency.** `TRD.md`'s stack list names GSAP, but
nothing before this phase used it — every scroll/entrance animation ran
through Framer Motion instead. Rather than leave the gap or force a risky
rewrite of working Framer code, `HeroSection` (`components/marketing/`)
gained one well-scoped `useHeroParallax` hook: `gsap.context()` (React-safe
cleanup) driving a `ScrollTrigger`-scrubbed drift+fade on the hero's Three.js
scene as the user scrolls past it, gated by `useReducedMotion()` like every
other animation in the app. `lib/gsap.ts`'s `registerGsap()` (written in
Phase 01, never called until now) is what makes this a one-line integration
instead of a new setup.

**SEO.** `site-config.ts` centralizes name/title/description/url;
`app/layout.tsx`'s metadata gained `metadataBase`/`openGraph`/`twitter`
blocks reading from it. Added the three Next.js file-convention routes that
didn't exist yet: `opengraph-image.tsx` (a programmatic `ImageResponse` —
no static asset to source), `sitemap.ts` (public marketing/auth routes
only), and `robots.ts` (disallows every authenticated `(app)` route —
dashboard, feed, messages, settings, admin — from indexing).

**Accessibility: heading audit.** Cross-referenced all ~22 routes against
`<h1>` presence and found a real, systematic gap: all four Settings pages
(`account`, `appearance`, `privacy`, `notifications`) and both Messages
states (`MessagesEmptyState`, `MessageThread`'s header) had never had a
page-level heading of any kind — they'd shipped in Phases 09–10 with only
`CardTitle`s (a `<div>`-based visual heading, not a real one) or plain
`<p>` tags. Fixed by adding a real `<h1>` to each Settings page and
promoting the two Messages headings from `<p>`. This surfaced redundant-text
follow-ups: `NotificationsForm`'s own `CardHeader` duplicated its page's new
`<h1>` exactly (removed), and `PrivacyForm`'s first card's title duplicated
its page's `<h1>` (renamed to "Visibility & access," differentiating it from
that page's second card, "Blocked users").

**Animation consistency.** Feed and Communities (both `.map()`-heavy,
content-consumption pages) and the Admin Overview/Analytics dashboards had
no entrance animation, unlike every other primary page in the app
(Dashboard, Profile, Project, a community's own page). Added `FadeIn` to
all four, staggered per section — the same treatment those comparable pages
already had, not a new pattern.

**Performance.** Verified via `npm run analyze` that Three.js still only
loads on the routes that render a scene (landing page) and that route-level
code-splitting is working as expected across all 25 built routes; no
regressions from the phase's other changes.

Verification for this phase: `npm run typecheck`, `npm run lint`, and
`npm run build` all clean (25/25 routes, including the three new SEO
file-convention routes); Playwright-driven smoke tests confirmed no runtime
errors and correct rendering across the landing page (both pre- and
post-scroll, to verify the GSAP parallax), the four updated Settings pages,
Feed, Communities, and a Messages thread.
