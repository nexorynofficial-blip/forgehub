# Assumptions & decisions log

Every place this build filled a gap the docs left open, or added something
not explicitly listed in `TRD.md`. Update this file when a later phase
revisits any of these.

## Product / data

- **Users + Profiles merged.** `TRD.md` §4 models `Users` and `Profiles` as
  separate DB entities. The frontend consumes them as one joined `User`
  type (`src/types/user.ts`) since no phase brief treats them separately —
  a REST/GraphQL layer would plausibly join them into one response anyway.
  Revisit if the real API ships them as two resources.
- **Route map is a plan, and it's now (almost) fully built.**
  `src/lib/routes.ts` and `docs/ARCHITECTURE.md` §3 laid out every route
  across all 12 phases as a typed registry back in Phase 01. As of
  Phase 11, every one of them is real except `/projects/new` — Phase 07
  scoped its brief to the project showcase page, not creation, and no
  later phase's brief covers it either. It's the one remaining
  incremental-delivery forward link (sidebar "New project" button, mobile
  FAB) still pointing at a 404.

## Design system

- **Font roles.** `UI_UX.md` §4 lists Inter, Space Grotesk, Satoshi with no
  role assigned. Mapped as: Inter → body/UI, Space Grotesk → headings/
  display, Satoshi → hero/marketing emphasis only. See
  `docs/DESIGN_SYSTEM.md`.
- **Satoshi has no files yet.** It isn't on Google Fonts, so it can't load
  via `next/font/google`, and `next/font/local` would hard-fail the build if
  pointed at a missing file. Used a manual `@font-face` in `globals.css`
  instead — it 404s silently and falls back to Space Grotesk until a real
  licensed `.woff2` is dropped in `public/fonts/satoshi/` (free for
  commercial use from fontshare.com).
- **Accent foreground color.** UI_UX.md gives background hexes for
  primary/secondary/accent/success/danger but no paired text color. White
  text fails WCAG AA (4.5:1) against primary (`4.34:1`) and danger
  (`3.06:1`). Near-black `#0A0A0B` text passes against all five accents
  (4.6:1–11.5:1) — used everywhere via `--on-brand`. Full computation in
  `docs/DESIGN_SYSTEM.md`. The accent hex values themselves are unchanged
  from spec.
- **Dark theme only, for now.** UI_UX.md §2 says "Dark First," which implies
  a light mode may follow, but no light values exist anywhere in the docs
  and no phase before 10 (Settings → Appearance) needs one. `next-themes` is
  wired up (`attribute="data-theme"`) so adding light-theme CSS values later
  doesn't require re-plumbing — but `enableSystem` is off and `forcedTheme`
  is `"dark"` so the app doesn't silently switch to an unstyled light mode.

## Stack additions beyond TRD.md §1

TRD.md's frontend stack list (Next.js, TypeScript, Tailwind, Framer Motion,
GSAP, Three.js, React Query, Zustand, React Hook Form, Zod) is what's
mandated; everything below was added to satisfy other hard requirements
(WCAG AA, "production quality", "reusable components") without contradicting
that list:

- **Radix UI primitives** — headless, accessible Dialog/DropdownMenu/
  Tooltip/Select/Popover/Tabs/Switch/Avatar/ScrollArea/Toast/Label/Separator.
  Building focus-trapped, keyboard-navigable, ARIA-correct versions of these
  from scratch is the highest-risk way to fail WCAG AA; Radix is the
  de facto standard for exactly this problem.
- **class-variance-authority, clsx, tailwind-merge** — the standard trio for
  typed Tailwind variant props (`<Button variant="primary" size="lg" />`)
  without string-concatenation bugs.
- **next-themes** — flash-free theme application (see above).
- **lucide-react** — icon set. No icon library is named anywhere in the
  docs; lucide is MIT-licensed, tree-shakeable, and stylistically matches
  the Linear/Vercel-adjacent aesthetic UI_UX.md asks for.
- **@next/bundle-analyzer, prettier, prettier-plugin-tailwindcss, cross-env**
  — dev-only tooling for the performance/"production quality" requirements
  in this session's own instructions; none ship in the production bundle.

## Three.js scope

Only vanilla `three` was installed — not `@react-three/fiber` or `@react-
three/drei`. TRD.md names "Three.js" specifically; adding a React
integration layer on top wasn't asked for and would be a second library to
justify. `components/three/SceneCanvas` wraps the imperative Three.js API
directly (mount/resize/render-loop/dispose), and `createScene` is the
extension point for actual scene content per page.

## Phase 02: Landing Page

- **Phase 01's verification page is gone.** `src/app/page.tsx` (the smoke
  test) was deleted and replaced by `src/app/(marketing)/page.tsx`, per the
  Phase 01 note that it would be. Root `app/layout.tsx` no longer renders
  `<main>` itself — see `docs/ARCHITECTURE.md` §4 — because marketing chrome
  and the future `(app)` shell wrap `<main>` differently.
- **Marketing copy is original, not sourced.** PRD.md and UI_UX.md give
  feature _names_ (§4 Core Features, §6 Landing Page) but no headline, body
  copy, or testimonial content. All hero/feature/testimonial/CTA text in
  `components/marketing/` is written for this build, not quoted from the
  docs — treat it as a first draft, not locked copy.
- **New mock data category: marketing/presentation data.** Testimonials,
  platform stats, the activity feed, and featured builders/communities
  (`src/types/marketing.ts`, `lib/mock/`, `lib/services/marketing-service.ts`)
  aren't in TRD.md §4's entity list — they're shaped for what the landing
  page renders, not full domain models. `FeaturedCommunity` in particular is
  a lighter-weight sibling of the real `Community` type in
  `src/types/community.ts`, not a replacement for it.
- **Server/Client boundary for Three.js.** Next.js App Router rejects
  `next/dynamic({ ssr: false })` inside a Server Component, and Server
  Components can't pass function props (like `createScene`) to a Client
  Component. `components/three/index.ts` is now `"use client"`, and any
  section composing a Three.js scene (e.g. `HeroSection`) must be a Client
  Component too. Documented in `docs/ARCHITECTURE.md` §6 so later phases
  don't hit the same build error.
- **`lucide-react`'s brand icons were removed upstream.** `Github` (and other
  brand/logo icons) no longer export from the installed `lucide-react`
  version — the package dropped them for trademark reasons. Used `Code2`
  instead anywhere a "view source" icon was needed.
- **Footer stays minimal.** No "Company / Blog / Careers" links — those
  pages don't exist and aren't in any phase's scope. The footer only links
  to on-page anchors and the auth routes, so nothing points at a page that
  doesn't exist yet outside the phase-03 auth 404s already noted above.

## Phase 03: Authentication

- **Auth is entirely frontend-simulated.** `lib/services/auth-service.ts`
  has no real backend to call — TRD.md §5 describes the Authentication API's
  shape but no phase brief says to stand up a server. Every function
  (`login`, `signup`, `requestPasswordReset`, `resendVerificationEmail`,
  `verifyTwoFactorCode`) resolves after a fixed 900ms delay and always
  succeeds; no credentials are checked, nothing is persisted. This exercises
  real loading/disabled states end-to-end without inventing fake failure
  modes the docs never specified. Revisit once a real API exists.
- **Login "succeeds" with no redirect to a dashboard.** `/dashboard` doesn't
  exist until Phase 04. `LoginForm` shows a toast confirming the mock call
  resolved instead of navigating somewhere that would 404.
- **Password rule is a guess.** No document states a password policy. Used a
  common baseline — 8+ characters, one uppercase letter, one number — enforced
  by the shared `password` Zod schema in `lib/validations/auth.ts` and
  visualized by `PasswordStrengthMeter`. Revisit if TRD.md's real auth
  service defines different rules.
- **`OtpInput` is hand-built, not Radix.** Radix has no digit-by-digit code
  input primitive. `components/auth/otp-input.tsx` implements focus
  management (auto-advance, backspace-to-previous, arrow-key navigation) and
  paste handling (a full 6-digit paste into any box fills forward from that
  box) directly, keeping the same accessible-primitives bar set for the rest
  of `components/ui/`.
- **OAuth buttons are visual-only.** `OAuthButtons` (Google/GitHub) render
  real brand marks and hover/focus states but have no `onClick` — no OAuth
  provider is configured anywhere in the stack. Wiring them is out of scope
  until a real auth backend exists.
- **`Checkbox` added to `components/ui/`.** Needed for "Remember me" (login)
  and "I agree to the Terms" (signup); wasn't built in Phase 01 because
  nothing needed it yet. Same Radix + `class-variance-authority` pattern as
  the rest of `components/ui/`.
- **Auth shell is a persistent split screen, not per-page layout.** UI_UX.md
  doesn't specify an auth page structure, so `AuthShell` (brand panel on
  `lg:` and up, centered form column always) is applied once in
  `(auth)/layout.tsx` rather than duplicated per page — matches how
  `(marketing)/layout.tsx` centralizes `SiteHeader`/`SiteFooter`. Below `lg`,
  `BrandPanel` collapses away and a small wordmark takes its place above the
  form.
- **`verify-email` is the one dynamic route in this phase.** It reads an
  `email` query param via an async Server Component (`searchParams` Promise,
  Next.js 15+ convention) to personalize "We sent a link to ___" — the only
  auth page that needs data at request time, so it's the only one Next
  marks `ƒ` (server-rendered on demand) instead of `○` (static) in the build
  output. Not a bug; every other auth route has no per-request input.
- **Login and 2FA now redirect to `/dashboard`.** Both forms originally
  toasted "the dashboard it redirects to lands in Phase 04" instead of
  navigating, since `/dashboard` didn't exist yet. Phase 04 built it, so
  both now call `router.push(routes.dashboard)` after the mock call
  resolves. Signup was unaffected — it already routed to `/verify-email`,
  which existed from the start of this phase.

## Phase 04: Dashboard

- **Notification "actor" is a joined view, like `User`.** `types/notification.ts`
  models `Notification` exactly as TRD.md §4 would (`actorId: ID`), but a
  widget needs a name and avatar to render, not an ID to look up. Added
  `NotificationWithActor` (`types/dashboard.ts`) the same way `User` merges
  `Users`+`Profiles` — see the Phase-agnostic note above. Mock data
  populates both the ID and the display fields directly since there's no
  join to perform yet.
- **Four dashboard-only presentation types, not TRD.md entities.**
  `TrendingProjectSummary`, `LeaderboardEntry`, `UpcomingEvent`, and
  `RecentConversationPreview` (`types/dashboard.ts`) follow the same
  precedent as `types/marketing.ts`'s `FeaturedCommunity`/`ActivityItem`:
  shaped for what a widget renders, not 1:1 with a full domain type.
  `RecentConversationPreview` in particular is a lighter sibling of the full
  `Conversation`/`Message` types (`types/message.ts`, built in Phase 01 for
  Phase 09) — it skips participant-ID resolution entirely rather than
  building a partial version of Phase 09's real messaging data layer.
- **Leaderboard XP matches `mockCurrentUser`.** `mockLeaderboard`'s
  `ava.codes` entry (rank 3, 8420 XP, "Architect") mirrors
  `mock/users.ts`'s `mockCurrentUser` exactly, so `LeaderboardWidget` can
  highlight "your row" correctly in the demo instead of showing two
  contradictory numbers for the same person.
- **Search is visual-only.** `AppTopbar` renders a styled search input
  (UI_UX.md doesn't ask for it explicitly, but PRD.md §4.11 Search and the
  Discord/Linear-referenced aesthetic both imply one belongs in the topbar);
  it has no `onSubmit` or results. No phase brief in
  `ForgeHub_ClaudeCode_Prompts/FRONTEND/` owns global search — revisit if a
  later phase adds a dedicated Search API integration.
- **Notifications live in a topbar dropdown, not a page.**
  UI_UX.md §7 lists "Notifications" as a dashboard section without
  specifying placement. `routes.ts` has no `/notifications` entry (only
  `settings.notifications`, which is _preferences_, owned by Phase 10) — so
  `NotificationsPanel` is a `Popover` off the bell icon, not a route. Revisit
  if a later phase wants a full notifications history page.
- **Chat widget stays a preview, not real-time.** UI_UX.md §7 lists "Chat"
  as a dashboard section; PRD.md §4.7 (Real-Time Chat, Socket.IO per TRD.md
  §2) is explicitly Phase 09's job. `QuickMessagesWidget` shows static mock
  previews with a "View all" link to `/messages` (which 404s until Phase 09)
  — same incremental-delivery pattern as every other forward link in this
  build.
- **`ActivityFeedWidget` reuses `LiveActivityFeed`, not a fork.** The
  landing page's "Live Activity Feed" (Phase 02) and the dashboard's "Feed"
  widget (UI_UX.md §7) both want the same live-updating list of platform
  activity — same data, same `refetchInterval` polling behavior. Rather than
  duplicating it into `components/dashboard/`, `LiveActivityFeed` gained an
  optional `className` prop (merged via `cn()`, which resolves the
  conflicting `max-w-md`) and `ActivityFeedWidget` is a one-line wrapper.
  The component now lives conceptually in both features; it stays physically
  in `components/marketing/` since that's where it was first built.
- **Admin nav item is role-gated, not removed.** `AppSidebar` only renders
  the "Admin" link when `user.role` is `moderator`, `community_admin`, or
  `platform_admin` — `mockCurrentUser`'s role (`verified_builder`) hides it
  today, matching TRD.md §7's RBAC requirement even though Phase 11 (Admin)
  hasn't built the destination yet.
- **New-project entry points, not a new-project form.** Both the sidebar's
  "New project" button and the mobile FAB link to `routes.newProject`
  (`/projects/new`), which 404s until Phase 07. Building the entry points
  now (rather than deferring them too) matches how the Phase 02 landing page
  already links to auth routes before they existed — the affordance is part
  of this phase's UI even though the destination isn't.

## Phase 05: Profile

- **`Achievement.iconUrl` and `Badge.iconUrl` are now nullable.** Both were
  typed `string` (required) since Phase 01, but every other image field in
  the codebase (`avatarUrl`, `bannerUrl`, `coverImageUrl`, ...) is
  `string | null` with a rendered fallback — no real icon files exist yet
  for either. Changed both to `string | null` for consistency;
  `AchievementsSection` renders a lucide `Award` icon when null instead of
  leaving the field unused.
- **Only 3 of the app's ~10 named builders got full `User` fixtures.**
  `mockUsersByUsername` (mock/users.ts) has `ava.codes` (the existing
  `mockCurrentUser`), plus new `dana.builds` and `riko.tanaka` fixtures —
  enough to demo "my profile" vs. "someone else's profile" vs. "unknown
  user" (`notFound()`). The other names seen elsewhere (Lena Brandt, Theo
  Marchetti, Amaka Chukwu, ...) exist only as lightweight mentions
  (`FeaturedBuilder`, `ActivityItem.actorName`, leaderboard rows) — giving
  every one of them a full profile isn't this phase's job and would mostly
  be unused fixture data until Feed/Communities need a broader user
  directory.
- **New full `Project` fixtures (`mock/projects.ts`), not a duplicate of
  `TrendingProjectSummary`.** Phase 04's `mock/trending-projects.ts` uses the
  lightweight dashboard-only type. Profile's "Pinned Projects" is the first
  feature that needs the _real_ `types/project.ts` `Project` shape (status,
  milestones, funding stage, ...) — which Phase 07 (Project Page) will also
  need — so this phase seeds it properly instead of extending the light
  type. Where an owner overlaps (Riko → Pixelforge, Dana → Tidal Notes),
  titles/descriptions match the Phase 04 fixtures for narrative consistency,
  even though the two mock files model different types.
- **"Pinned Projects" shows most-liked, not actually pinned.** No document
  (PRD.md, TRD.md, UI_UX.md) defines a pin/unpin action anywhere, and
  `Project` has no `isPinned` field. `getPinnedProjects` (project-service.ts)
  just returns the owner's projects sorted by `metrics.likes`, capped at 3.
  Revisit if a later phase adds real pinning.
- **Contribution heatmap is seeded, not random.** `Math.random()` would
  produce a different grid on every render/refetch, which would be visibly
  broken for a "contribution history" that's supposed to be stable. `mock/
contributions.ts` uses a small seeded PRNG (mulberry32) keyed by username,
  so each profile gets a distinct but _stable_ pattern.
- **Timeline reuses `ActivityItem`, not a new type.** Same shape as the
  landing page's/dashboard's activity feed (kind, actor, message,
  timestamp) — a profile timeline is that same concept scoped to one
  builder, so `mock/timeline.ts` just keys a `Record<username, ActivityItem[]>`
  instead of introducing a parallel "TimelineEvent" type.
- **Followers is a preview + modal, not a route.** Same reasoning as Phase
  04's notifications: no route exists for it (`routes.ts` has no
  `/profile/[username]/followers`), and UI_UX.md §8 just lists "Followers"
  as a profile section. `FollowersWidget` shows an avatar stack + count,
  expanding into a `Dialog` with the fuller preview list on click. Every
  profile shares one `mockFollowerPreviews` pool (mock/followers.ts) rather
  than per-user follower lists — there's no follow graph to seed yet.
- **Follow/unfollow is local component state, not persisted.** Clicking
  "Follow" flips a `useState` boolean and fires a toast; it doesn't change
  `followersCount` or survive a refresh. A real implementation needs a
  Follow API call and cache invalidation (TRD.md §5) that doesn't exist yet.
- **Added `(app)/not-found.tsx` and root `app/not-found.tsx`.** Neither
  existed before this phase. `notFound()` (called when a username doesn't
  match) needed _some_ not-found UI to render, and Next's unstyled default
  wouldn't match the app. `(app)/not-found.tsx` keeps the sidebar/topbar
  visible for any bad `(app)` URL; the root one covers routes outside every
  group. See `docs/ARCHITECTURE.md` §12 for the full data-fetching
  rationale (this is also the first Server-Component page in the app).
- **Banner uses a CSS gradient animation, not a video/Lottie.** UI_UX.md §8
  asks for an "Animated Banner"; no real `bannerUrl` exists in any fixture.
  Added one small CSS keyframe (`animate-gradient-shift`, `app/globals.css`)
  that slowly drifts the same radial-gradient treatment `BrandPanel` (Phase 03) uses statically — consistent with the "CSS gradients instead of a
  second Three.js instance" call already made for auth, and automatically
  covered by the existing global `prefers-reduced-motion` block.
- **Social links reuse the Phase 03 OAuth icons.** `SocialLinkIcon`
  (`components/profile/`) imports `GitHubIcon` from `components/auth/
oauth-icons.tsx` rather than duplicating it, adds a hand-drawn X mark the
  same way, and falls back to a generic globe icon for any other
  `SocialLink.platform` string (it's freeform, not an enum).

## Phase 06: Feed

- **`@radix-ui/react-hover-card` added.** UI_UX.md §10 explicitly lists
  "Hover Preview," and no primitive for it existed (Popover has no
  hover-intent timing or built-in keyboard/touch fallback). Same
  justification already used for every other Radix addition: building
  accessible hover-intent behavior from scratch is the highest-risk way to
  fail WCAG AA. `AuthorHoverCard` (`components/feed/`) builds the preview
  entirely from the `PostAuthor` already embedded in the post — no extra
  fetch on hover, so it stays instant.
- **No ranking algorithm — six filters, six sort heuristics.** PRD.md §4.4
  names Trending/Latest/Following/Recommended/Popular Today/AI Recommended
  as distinct feed modes, but nothing in TRD.md's Feed or Recommendation
  API implies real logic exists yet (no ML, no graph, no engagement-decay
  formula). `feed-service.ts`'s `sortForFilter` just re-sorts one shared
  mock pool by a different field per filter (likes, recency, comment count,
  a weighted blend) — good enough to demonstrate six working tabs, not a
  ranking system. Revisit entirely once the Recommendation API exists.
- **Likes and poll votes are optimistic-local, not persisted.** Same
  reasoning as Phase 05's follow button: clicking Like or voting in a poll
  updates only that component's `useState` — no Like/Vote API exists (TRD.md
  §5), so nothing survives a refresh or shows up for other users. Comments
  and composer posts go a step further (persisted into the mock module's
  in-memory arrays / the React Query cache) since they need to survive
  scrolling away and back within the same session — see
  `docs/ARCHITECTURE.md` §13.
- **"Live Comments" / "Live Likes" (UI_UX.md §10) means optimistic UI, not
  WebSockets.** Real-time push is explicitly TRD.md §6's Socket.IO layer,
  owned by Phase 09 (Messaging) — this phase makes interactions feel
  instant locally, it doesn't broadcast them. `checkForNewPosts` similarly
  simulates "Auto Refresh" by returning a nonzero count once per session
  rather than actually detecting new server-side posts.
- **Markdown renders as plain text.** `PostType` includes `"markdown"`, but
  no markdown-rendering library is in TRD.md's stack list, and adding one
  for a single post type felt like the wrong tradeoff this phase. Markdown
  posts render their `content` exactly like `"text"` posts — literal
  `**bold**` asterisks and all. Revisit if a later phase needs real
  markdown rendering (rich project descriptions would be the more likely
  trigger than feed posts).
- **Image/video posts show placeholder tiles, not real media.** Every
  `mediaUrls` entry in the mock data is an opaque id string (`"img_1"`,
  `"vid_1"`), not a real URL — consistent with every avatar/banner/cover
  field elsewhere in the app being `null`. `PostTypeContent` renders one
  placeholder tile per `mediaUrls` entry (an `ImageIcon`) or a single
  play-button tile for video, rather than pointing `next/image` at
  non-existent URLs.
- **Code blocks have no syntax highlighting.** `CodeSnippet.language` is
  stored and displayed as a label, but the code itself renders in a plain
  monospace `<pre>` — no highlighter library (Shiki, Prism, etc.) is in
  TRD.md's stack list. The copy-to-clipboard button is real
  (`navigator.clipboard`), the coloring isn't.
- **`Paginated<T>` (`types/common.ts`) used for the first time.** Defined
  in Phase 01 anticipating REST pagination, but nothing before this phase
  needed cursor-based paging — Phase 04's dashboard widgets and Phase 05's
  profile sections all fetch fixed-size, un-paginated lists.
  `feed-service.ts`'s `getFeedPage` is the first consumer; its cursor is
  just a stringified array index over the in-memory sorted pool, not a
  real opaque server cursor.
- **Composer only offers Text/Update/Milestone.** `PostType` has nine
  values; Image/Video/Code/Poll all need dedicated upload or authoring UI
  (a file picker, a code editor, a poll-option builder) that PRD.md doesn't
  detail and this phase's brief doesn't ask for ("posts, comments UI,
  reactions, infinite scrolling" — not a full composer). The three offered
  types need nothing but a text field, so they're what's wired up; the rest
  can still be _viewed_ via the seeded mock posts.

## Phase 07: Project Page

- **Scoped to the showcase page, not project creation.** The phase brief
  says "Build project showcase page with roadmap, gallery, updates,
  discussion" — four named things, no mention of authoring. `/projects/new`
  (linked from the sidebar's "New project" button and the mobile FAB since
  Phase 04) stays a dangling link; no phase in
  `ForgeHub_ClaudeCode_Prompts/FRONTEND/` explicitly owns a project-creation
  form. Revisit if a later phase (plausibly Final Polish) needs it, or if
  asked to build it directly.
- **Fixed a real Phase 04 bug: trending projects linked by `id`, not
  `slug`.** `TrendingProjectsWidget` (dashboard) always had both fields
  available on `TrendingProjectSummary` but linked via `routes.project(
project.id)`. That 404'd silently before this phase (no project page
  existed to hit), but would have been a live broken link the moment this
  page shipped — since `Profile`'s pinned-project cards already correctly
  used `.slug`. Fixed to use `.slug`, matching the one canonical
  identifier used everywhere else. Caught while building this phase, not
  by a separate audit — worth remembering that cross-phase links can go
  stale silently until their destination exists.
- **`[projectId]` route param resolves against `Project.slug`.** Same
  pattern as `[username]` resolving by username, not a numeric id — see
  `docs/ARCHITECTURE.md` §12. The param is still named `projectId` because
  that's what `routes.ts` planned in Phase 01; renaming it purely for
  internal consistency wasn't worth touching a public-shaped API surface
  for.
- **"Progress Timeline" and "Roadmap" (UI_UX.md §9) are one section, not
  two.** Both would render from the exact same `milestones` data — an
  overall progress bar plus a chronological list of milestones with their
  completion state. `ProjectRoadmap` covers both bullets in one component
  rather than building two near-identical UIs. Same reasoning as Phase 04
  merging Dashboard's implied duplicate concepts.
- **"Discussion" and "Comments" (UI_UX.md §9) are also one section.**
  Same logic — PRD.md has no separate "project comment" vs. "project
  discussion" data model, just one flat comment thread makes sense.
  `ProjectDiscussionComment` (types/project-page.ts) is a project-scoped
  sibling of `CommentWithAuthor` (Phase 06), not a reuse of it — that
  type's `postId` field is specifically post-shaped, and repurposing it to
  mean "either a post or a project" would be a worse type than just having
  two small ones.
- **Refactor: `PostAuthor` fixtures consolidated into `mock/people.ts`.**
  Ava/Dana/Riko/Amaka/Theo/Lena were separately hand-declared in both
  `mock/posts.ts` and `mock/comments.ts` (Phase 06). Project Team needed
  the same six people a third time; rather than a third copy, extracted
  one canonical source (`mockPeople`, `mockPeopleById`) that Feed's mock
  files now import from too. `PROJECT_STATUS_META` similarly moved from
  being local to `components/profile/pinned-projects-section.tsx` into
  `lib/project-meta.ts` (also gaining `PROJECT_FUNDING_META`) so the
  Project Page uses identical status labels instead of a second copy.
- **Team/updates/discussion authors resolve through `mockCurrentUser` +
  `mock/people.ts` together.** `mockCurrentUser` (the signed-in user, Ava)
  isn't itself in the `mock/people.ts` directory — it lives in
  `mock/users.ts` as a richer full `User`. `project-service.ts`'s
  `resolvePerson` checks `mockCurrentUser` first, then falls back to the
  people directory, so Ava can be a project owner/team member/update
  author like everyone else without a duplicate lightweight record.
- **Only two projects got a multi-person team + gallery.** Forge
  Components and Pixelforge (both already had collaborators implied by
  their Phase 06 feed posts — Theo/Lena and Amaka respectively) gained
  `members`/`gallery` entries; every other mock project stays solo with an
  empty gallery. That's a realistic mix for a builder platform, not a gap —
  `ProjectGallery` and the multi-row `ProjectTeam` list both needed at
  least one real example to verify, and forcing every project into a full
  team would be busywork for fixtures no page depends on.
- **Gallery images are placeholder tiles, click-to-lightbox, no real
  media.** Same convention as Feed's image posts (Phase 06) and every
  avatar/banner/cover elsewhere: `gallery` entries are opaque ids, not
  URLs. The `Dialog`-based lightbox (prev/next, position counter) is fully
  functional — only the pictures themselves are placeholders.

## Phase 08: Communities

- **No "Create Community" flow.** PRD.md §4.6 lists it as a feature, but
  `routes.ts` (the Phase 01 plan) never allocated a `/communities/new`
  entry the way it did for `/projects/new` — so unlike Phase 07's project
  page, there's no pre-existing dangling link pointing at a creation form.
  The phase brief itself only asks for "community discovery and community
  page UI." Left unbuilt; revisit if asked for directly or if
  Final Polish wants to close every remaining PRD gap.
- **Full `Community` fixtures build on the Phase 02 `FeaturedCommunity`
  ones, don't replace them.** `mockFeaturedCommunities` (landing page,
  lightweight: id/name/memberCount/category) keeps serving the marketing
  page. `mockCommunities` (full `Community` type) reuses the same six ids,
  names, and categories so the two lists agree, then adds everything the
  richer page needs (description, tags, rules, moderators, pinned posts,
  events). Same "lighter type stays, full type gets added alongside it"
  precedent as Phase 05's `TrendingProjectSummary` → full `Project`.
- **Discovery events and community-page events are the same facts, told
  twice.** Dashboard's `mock/events.ts` (Phase 04, `UpcomingEvent` type —
  presentation-shaped, includes `communityName`/`isOnline`/
  `attendeeCount`) already had 3 events for AI Tooling, Indie SaaS, and
  Design Systems. `mockCommunities`' `events` field (`CommunityEvent[]`,
  the TRD-shaped type embedded in `Community`) repeats those same
  titles/dates for the matching communities rather than inventing
  different ones — so a user seeing "AI Tooling: Show & Tell, Aug 2" on
  the dashboard and the same event on the community page isn't looking at
  two contradictory data sources. The two types aren't unified into one
  because they're genuinely shaped for different consumers (a cross-
  community dashboard widget vs. one community's own event list).
- **Pinned posts resolve against Feed's real mock pool, not fake ones.**
  `Community.pinnedPostIds` are real ids from `mock/posts.ts` (Phase 06).
  `getCommunityPinnedPosts` looks them up and `CommunityPinnedPosts`
  renders them with the actual `PostCard` component — full like/comment/
  poll/code functionality included, not a simplified read-only preview.
- **Refactor: `AvatarStackDialog` extracted from `FollowersWidget`.**
  Phase 05's profile "Followers" (avatar stack + count, opens a dialog
  with the full preview list) is structurally identical to what
  Communities' "Members" needed. Rather than a second copy, extracted the
  interactive piece into `components/shared/avatar-stack-dialog.tsx` (new
  `components/shared/` folder — see docs/ARCHITECTURE.md §1) and refactored
  `FollowersWidget` to use it; `CommunityMembers` is now a ~25-line
  wrapper instead of a duplicate of the original ~90-line component.
- **Community search is real (client-side), unlike the topbar's.** The
  topbar search (Phase 04) is visual-only — no phase owns global search
  yet (PRD.md §4.11, no dedicated phase brief). `CommunityDiscovery`'s
  search box is different: it's scoped to one small, already-fetched
  dataset (six communities), so filtering it in the browser is trivial and
  actually works, rather than being another non-functional placeholder.
  Not a precedent for global search — just a case where "real" was cheap.
- **Category filter tabs are derived from the data, not hardcoded.**
  `CommunityDiscovery` computes its tab list from the unique `category`
  values across `mockCommunities` rather than a fixed list — adding a
  community with a new category automatically gets a working filter tab,
  no second place to update.

## Phase 09: Messaging

- **No real-time transport — every "live" behavior is polling.** TRD.md §2
  names Socket.IO and §6 lists Chat/Typing Indicators/Online Users as
  real-time systems, but this phase is explicitly frontend-only with no
  backend. `checkTypingIndicator` (messaging-service.ts) is a `useQuery`
  with `refetchInterval: 5_000` that returns a typer once every four polls
  — the same simulated-push pattern already used for Phase 04's
  notification check and Phase 06's `checkForNewPosts`, now a third time.
  Online status (`mockOnlineUserIds`) is a static set, not a live presence
  system. Revisit entirely once a real Socket.IO connection exists.
- **Full `Conversation`/`Message` fixtures are derived from, not
  duplicated from, the Phase 04 dashboard preview.** `mockRecentConversations`
  (`RecentConversationPreview`, dashboard-only lightweight type) already
  established three conversations — Dana, Lena, Theo, with specific last-
  message text and unread counts. `mock/conversations.ts`'s new
  `mockConversations: Conversation[]` reuses the same three ids
  (`cvo_001`–`cvo_003`) and builds each one's `lastMessage` by taking the
  last entry of that thread's array in `mock/messages.ts` (a `lastOf()`
  helper), rather than hand-typing a matching string that could drift out
  of sync with the actual thread content. This also means the dashboard's
  `QuickMessagesWidget` links (`routes.conversation(id)`, built in Phase 04
  before `/messages/[conversationId]` existed) now resolve correctly
  without any fix needed — the ids were always going to match.
- **Added a fourth, group conversation not in the dashboard preview.**
  `cvo_004` ("Forge Components", Ava + Theo + Lena) demonstrates the
  brief's "Discord-style" multi-participant case — sender names above
  bubbles, avatars only on the first message of a run — which none of the
  three 1:1 conversations exercise. The participants deliberately match
  Phase 07's Forge Components project team for narrative consistency.
- **Read receipts show only on the thread's last own message, not every
  one.** A naive "Seen"/"Delivered" label under every sent bubble is noisy
  and isn't how any real chat app does it. `MessageThread` computes
  `showStatus` as `isOwn && index === messages.length - 1`; `isSeen` then
  checks whether every other participant's id is in that message's
  `seenByUserIds`.
- **Message search is conversation-name search, not full-text.** Same
  scoping call as Phase 08's community search: PRD.md §4.7 lists "Message
  Search" as a feature, but searching every message body across every
  conversation is a materially bigger feature (and arguably needs a real
  index, not a client-side scan) than this phase's "conversations and
  chat" brief asks for. `ConversationList`'s search filters by
  participant/group name only.
- **Composer's file attach is a placeholder chip, not a real upload.**
  Same convention as every other media placeholder in this build (feed
  images, project gallery): clicking the paperclip button adds a mock
  `MessageAttachment` (`type: "file"`, a fixed filename) to a pending-chip
  state, removable before sending. `MessageBubble` fully renders both
  `"file"` and `"image"` attachment kinds (the image path is exercised by
  seeded historical messages, e.g. `msg_001_3`'s file attachment), even
  though the composer only lets you attach the file kind interactively.
  Voice notes aren't built at all — PRD.md §4.7 marks them "(Phase 2)"
  explicitly, i.e. out of scope for this build entirely, not just this
  phase.
- **Emoji picker is a fixed 24-emoji grid, not a full picker library.**
  PRD.md §4.7 just says "Emoji" with no detail. A `Popover` with a
  hardcoded grid (`components/messages/emoji-picker.tsx`) satisfies the
  requirement without adding an emoji-picker dependency or a Unicode
  emoji-metadata dataset for search/categories — reasonable for a mock
  frontend with no real message persistence anyway.
- **`(app)/messages/` is the first section with its own nested layout.**
  Every route so far has relied purely on `(app)/layout.tsx`'s sidebar/
  topbar chrome. Messaging's two-pane, fixed-height, independently-
  scrolling requirement doesn't fit the normal "page content flows and the
  whole viewport scrolls" pattern every other page uses, so
  `(app)/messages/layout.tsx` adds `MessagesShell` on top. See
  `docs/ARCHITECTURE.md` §14 for the full responsive-pane mechanics.

## Phase 10: Settings

- **Light/System theme are genuinely disabled, not a broken toggle.**
  UI_UX.md §2 says "Dark First" (implying a future light mode) and §3's
  color palette defines _only_ dark values — no light-mode hex codes exist
  anywhere in the source docs. `docs/ASSUMPTIONS.md`'s own Phase 03 entry
  flagged Appearance settings as the natural point to revisit this. Given
  the choice between (a) inventing a full second palette not specified
  anywhere and re-verifying every component that uses hardcoded dark-tuned
  values (glass blur, gradient banner overlays, etc.) against it, or
  (b) presenting Light/System honestly as "Coming soon," this build chose
  (b) — `next-themes` stays exactly as configured in Phase 01
  (`forcedTheme="dark"`, `enableSystem={false}`), untouched. `AppearanceForm`
  is a real, wired-up settings page; it just doesn't claim to do something
  no design spec defines.
- **A real, reproducible React Query reactivity bug was found and fixed —
  not worked around blindly.** See `docs/ARCHITECTURE.md` §15 for the full
  investigation (cache-state verification via `getQueryData`/
  `getQueryState`, isolating it to `.map()`-generated interactive lists via
  a controlled `useState` counter test, ruling out `PrivacyForm` as a
  counter-example). Both affected components (`NotificationsForm`,
  `NotificationsPanel`) were rewritten to seed local `useState` from the
  query once, matching every other instant-feedback control in this app.
  This is now the standing pattern for this class of UI, not a one-off.
- **`PrivacyForm`'s toggles have no data model backing them beyond this
  phase.** PRD.md §4.6 doesn't list a "Privacy" feature section at all (no
  UI_UX.md section either, same gap as Communities before it). Profile
  visibility, message permissions, and the two-factor toggle are a
  reasonable, common set for a social platform, not a literal spec
  mapping — the two-factor toggle here is cosmetic and doesn't actually
  gate the `/2fa` flow built in Phase 03 (no session/auth state exists to
  gate in the first place).
- **Notification preferences reuse `NotificationType` (Phase 04), not a
  new enum.** `NotificationPreferences` (`types/settings.ts`) is
  `Record<NotificationType, {inApp, email}>` — one row per existing type
  (Likes, Comments, Mentions, ...), so PRD.md §4.8's notification list and
  this settings page can never drift out of sync with each other.
- **Account form fields are a curated subset of `User`, not every field.**
  `User` (Phase 01) has ~20 fields; the form covers the ones a person would
  actually edit routinely (name, username, email, bio, experience, two
  social links, skills, tech stack) plus a separate password-change card.
  Read-only/derived fields (`xp`, `builderRank`, `followersCount`,
  `role`, ...) aren't editable here — they're either computed
  (reputation) or would need moderation/admin tooling (role) that's out of
  this phase's scope. Skills/tech stack are plain comma-separated text
  inputs rather than a tag-editor component — functional and simple,
  matching how the same fields are _displayed_ elsewhere (joined with
  `", "`) without introducing a new form-control primitive for one page.
- **`email`/`password` Zod rules exported from `validations/auth.ts` and
  reused, not redefined.** `validations/settings.ts`'s account and
  change-password schemas import them directly — same password complexity
  rule (8+ chars, uppercase, number) enforced at signup now also governs
  changing your password, with one source of truth for the regexes.
- **Danger zone (delete account) and avatar upload are both visual-only.**
  "Delete account" opens a real confirmation `Dialog` and shows a toast
  explaining it's a mock action — explicit about not being wired up, not
  silently doing nothing. "Change avatar" has no file picker at all; no
  phase in this build implements file/image upload (Cloudinary is TRD.md
  §2's mandated host but no upload flow exists anywhere yet), consistent
  with every other avatar/image being a `null`-with-fallback placeholder
  throughout the app.

## Phase 11: Admin

- **`mockCurrentUser`'s role changed from `verified_builder` to
  `platform_admin`.** Phase 04's `AppSidebar` already hid the Admin nav
  link behind an `isAdminRole` check specifically anticipating this phase;
  with the demo user not an admin, this section would be unreachable
  through the UI at all. Ava becoming a platform admin doesn't contradict
  anything in PRD.md's user journey (§5) — "admin" isn't a persona the
  journey walks through, it's a role assignment — and it's what makes
  Phase 11 actually demonstrable rather than a page nobody in the demo can
  reach. Checked for fallout first: grepped for every other `.role ===`
  comparison in the codebase (one match, an unrelated `ProjectMemberRole`
  check in `project-hero.tsx`) before making the change.
- **RBAC enforced at the route level, not just the nav link.** TRD.md §7
  requires RBAC; Phase 04 only hid the sidebar link. `AdminGuard`
  (`components/admin/`) adds the second half — visiting `/admin/*`
  directly now re-checks the role and shows "Access denied" for a
  non-admin, rather than trusting that nobody would type the URL. Same
  caveat as everywhere else in this build: purely client-side, since no
  auth/session backend exists to enforce it server-side.
- **Refactor: `isAdminRole` extracted to `lib/rbac.ts`.** The admin-role
  `Set` was local to `AppSidebar` (Phase 04). `AdminGuard` needed the
  identical check; rather than a second hardcoded list that could quietly
  drift from the first (e.g. someone adds a role to one Set and not the
  other), extracted one shared source. See `docs/ARCHITECTURE.md` §16.
- **PRD.md §4.12's six bullets (Reports, Moderation Queue, Flagged Posts,
  Content Removal, Ban Users, Shadow Ban) are one connected workflow, not
  six features.** They all describe the same loop: something gets
  flagged → a moderator reviews it → takes an action. Modeled as one
  `Report` entity (`types/admin.ts`) with a small action set
  (dismiss/resolve/ban author/shadow-ban author) on the Reports page,
  rather than building six separate surfaces that would all show
  overlapping data. "User Management" and "Analytics" (§4.12's other two
  bullets) map onto the Users and Analytics pages `routes.ts` already
  planned for.
- **Report targets resolve against real content from every earlier
  phase.** `mockReports` (`mock/reports.ts`) references actual ids from
  `mock/posts.ts` (Phase 06), `mock/comments.ts` (Phase 06),
  `mock/projects.ts` (Phase 07), and `mock/communities.ts` (Phase 08) —
  `admin-service.ts`'s `resolveTargetSummary` looks the real content up
  rather than the report carrying a pre-baked summary string that could
  disagree with the source. A `"user"`-type report targets a person
  directly (`targetAuthorId` = `targetId`), the only case where target and
  author are the same entity.
- **`ModerationStatus` is a new axis, not a repurposed field.** `UserRole`
  (Phase 01, `types/common.ts`) governs permissions; whether someone is
  banned or shadow-banned is a different, orthogonal concept — a platform
  admin can still be `active`/`banned`/`shadow_banned` independently of
  their role. Modeled as `AdminUserSummary.status`
  (`ModerationStatus`), not a new `UserRole` value.
- **Weekly signups are hand-authored illustrative data, not derived from
  `mockAdminUsers`.** Only 7 admin-user fixtures exist — nowhere near
  enough to plot a meaningful 8-week trend. `mock/analytics.ts` is a
  small, explicitly-labeled illustrative series (same treatment as
  trending projects, leaderboard, and every other "enough fixtures to
  demonstrate the UI, not a simulation" mock file in this build) ending
  near a value consistent with `mockPlatformStats`.
- **Charts are hand-rolled SVG, not a charting library.** Both Analytics
  charts are single-series bar charts. Per the dataviz skill loaded for
  this phase: a single series needs no legend, uses one hue, and doesn't
  justify pulling in a charting dependency (none is in TRD.md's stack
  list). Mark-color contrast against the card/surface backgrounds was
  computed via the WCAG relative-luminance formula rather than assumed —
  see `docs/ARCHITECTURE.md` §16 for the numbers.
- **"Reports by reason" has no hover tooltip; "Weekly signups" does.**
  Every bar in the reasons chart is already direct-labeled with its exact
  count (short category list, values fit beside each bar), so a value is
  always visible without hovering — the dataviz skill's "tooltips enhance,
  they never gate" rule is satisfied by the direct labels alone. The
  signups chart only labels its axis (8 bars would be cluttered with a
  number over every one), so it gets a real hover tooltip to surface the
  exact value per week.

## Phase 12: Final Polish

- **No new features — an audit phase.** Unlike Phases 02–11, this phase's
  brief is to harden what already exists (dead code, SEO, accessibility,
  performance, animation consistency, the one unused mandated dependency),
  not to build a new section. See `docs/ARCHITECTURE.md` §18 for the full
  account of all six passes and what each one found.
- **`hooks/use-mounted.ts` deleted, not kept "just in case."** A systematic
  cross-reference of every file in `lib/`, `hooks/`, `store/`, `providers/`,
  `types/` against its callers found exactly one genuinely dead file. Every
  other candidate that looked unused on a first pass (barrel-exported
  `types/*`, `components/three/scene-canvas.tsx`) turned out to have a real
  caller reached indirectly (a barrel `index.ts`, a `next/dynamic` import).
- **GSAP was in `TRD.md`'s stack list but had zero call sites until this
  phase.** `lib/gsap.ts` existed since Phase 01 (a `registerGsap()` helper
  registering `ScrollTrigger`) but nothing ever imported it — every scroll/
  entrance animation in the app went through Framer Motion instead. Rather
  than leave a mandated dependency completely unused, or risk a broad
  rewrite of already-working Framer code to force GSAP in everywhere,
  added one scoped, real use: a `ScrollTrigger`-scrubbed parallax/fade on
  the landing hero's Three.js scene as the user scrolls past it
  (`useHeroParallax` in `components/marketing/hero-section.tsx`), using
  `gsap.context()` for React-safe cleanup and gated by the same
  `useReducedMotion()` check every other animation in the app respects.
- **Heading-hierarchy gap across Settings and Messages, present since
  Phases 09–10, never caught until this phase's audit.** All four Settings
  pages (`account`, `appearance`, `privacy`, `notifications`) had only a
  `CardTitle` (visually a heading, but a plain `<div>`, not an `<h1>`) or no
  heading at all; both Messages states (`MessagesEmptyState`,
  `MessageThread`'s conversation-name header) used a `<p>` where an `<h1>`
  belonged. Fixed by adding real page-level `<h1>`s to all four Settings
  pages and promoting both Messages headings. Two follow-on redundant-text
  fixes fell out of this: `NotificationsForm`'s `CardHeader` exactly
  duplicated its page's new `<h1>` (removed, since it's the only card on
  that page), and `PrivacyForm`'s first `CardTitle` ("Privacy") duplicated
  its page's `<h1>` (renamed to "Visibility & access" to also read
  distinctly from its sibling card, "Blocked users").
- **FadeIn added to Feed, Communities, Admin Overview, and Admin
  Analytics** — the four primary content pages that had shipped (Phases
  06, 08, 11) without the entrance animation every comparable page
  (Dashboard, Profile, Project, a community's own page) already had. Judged
  by a content-consumption-vs-task-oriented-page distinction, not applied
  blanket-wide — auth forms, settings forms, and the messages shell stay
  as they were, since instant appearance is more appropriate for
  form-heavy or persistent-chrome UI than for a page whose whole job is
  presenting a feed of content.
- **`site-config.ts` added as the single source for name/title/description/
  url**, consumed by both `app/layout.tsx`'s metadata block and
  `app/opengraph-image.tsx`, so the two can't drift apart. The OG image is
  generated programmatically via `next/og`'s `ImageResponse` (dark
  background, brand gradient, wordmark) rather than a static asset, since
  no real marketing artwork exists anywhere in this build's fixtures.
  `sitemap.ts` lists only the public marketing/auth routes (nothing behind
  the `(app)` shell is meant to be indexed); `robots.ts` explicitly
  disallows `/dashboard`, `/feed`, `/messages`, `/settings`, and `/admin`.
