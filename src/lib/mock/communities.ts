import type { Community, FeaturedCommunity } from "@/types";
import { AMAKA, AVA, DANA, LENA, RIKO, THEO } from "@/lib/mock/people";
import { mockCurrentUser } from "@/lib/mock/users";

export const mockFeaturedCommunities: FeaturedCommunity[] = [
  {
    id: "cmy_001",
    name: "AI Tooling",
    memberCount: 8400,
    category: "Artificial Intelligence",
  },
  { id: "cmy_002", name: "Indie SaaS", memberCount: 6200, category: "Startups" },
  { id: "cmy_003", name: "Design Systems", memberCount: 3100, category: "Design" },
  { id: "cmy_004", name: "Hackathon Central", memberCount: 5900, category: "Events" },
  { id: "cmy_005", name: "Open Source", memberCount: 9700, category: "Engineering" },
  { id: "cmy_006", name: "Solo Founders", memberCount: 4300, category: "Startups" },
];

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysFromNow = (days: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
};

const STANDARD_RULES = [
  "Be respectful — critique the work, not the person.",
  "No spam, unsolicited DMs, or self-promotion outside designated threads.",
  "Search before asking — someone may have already answered.",
  "Keep discussion on-topic for the category.",
];

/**
 * Full `Community` fixtures (TRD.md §4), built on the same six communities
 * `mockFeaturedCommunities` (Phase 02) already established — same ids,
 * names, and categories, extended with everything the full type needs.
 * `moderatorIds`/`pinnedPostIds` reference `mock/people.ts` and
 * `mock/posts.ts` (Phase 06/07) respectively; the AI Tooling / Indie SaaS /
 * Design Systems events match `mock/events.ts`'s dashboard fixtures by date
 * and title so the two surfaces agree. See docs/ASSUMPTIONS.md (Phase 08).
 */
export const mockCommunities: Community[] = [
  {
    id: "cmy_001",
    slug: "ai-tooling",
    name: "AI Tooling",
    description:
      "Builders shipping AI-powered products — models, agents, evals, and the infra around them.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Artificial Intelligence",
    tags: ["AI", "Machine Learning", "Infra"],
    rules: STANDARD_RULES,
    moderatorIds: [THEO.id, AMAKA.id],
    memberCount: 8400,
    pinnedPostIds: ["pst_005", "pst_010"],
    events: [
      {
        id: "cev_001",
        title: "AI Tooling: Show & Tell",
        startsAt: daysFromNow(1, 18),
        endsAt: null,
      },
    ],
    createdAt: daysAgo(420),
  },
  {
    id: "cmy_002",
    slug: "indie-saas",
    name: "Indie SaaS",
    description:
      "Solo and small-team founders building and marketing their own SaaS products in public.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Startups",
    tags: ["SaaS", "Bootstrapped", "Marketing"],
    rules: STANDARD_RULES,
    moderatorIds: [AVA.id, DANA.id],
    memberCount: 6200,
    pinnedPostIds: ["pst_007", "pst_001"],
    events: [
      {
        id: "cev_002",
        title: "Indie SaaS Office Hours",
        startsAt: daysFromNow(3, 17),
        endsAt: null,
      },
    ],
    createdAt: daysAgo(500),
  },
  {
    id: "cmy_003",
    slug: "design-systems",
    name: "Design Systems",
    description:
      "Design tokens, component APIs, accessibility, and everything else that goes into a real design system.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Design",
    tags: ["Design Systems", "Accessibility", "Component Libraries"],
    rules: STANDARD_RULES,
    moderatorIds: [AVA.id],
    memberCount: 3100,
    pinnedPostIds: ["pst_003"],
    events: [
      {
        id: "cev_003",
        title: "Design Systems Meetup",
        startsAt: daysFromNow(5, 12),
        endsAt: null,
      },
    ],
    createdAt: daysAgo(310),
  },
  {
    id: "cmy_004",
    slug: "hackathon-central",
    name: "Hackathon Central",
    description:
      "Find teammates, share hackathon projects, and swap notes on what actually wins judges over.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Events",
    tags: ["Hackathons", "Team Building"],
    rules: STANDARD_RULES,
    moderatorIds: [RIKO.id, LENA.id],
    memberCount: 5900,
    pinnedPostIds: ["pst_002"],
    events: [],
    createdAt: daysAgo(180),
  },
  {
    id: "cmy_005",
    slug: "open-source",
    name: "Open Source",
    description:
      "Maintainers and contributors talking releases, governance, and how to keep a project sustainable.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Engineering",
    tags: ["Open Source", "Maintainers"],
    rules: STANDARD_RULES,
    moderatorIds: [RIKO.id],
    memberCount: 9700,
    pinnedPostIds: ["pst_009", "pst_003"],
    events: [
      {
        id: "cev_004",
        title: "Contributor Office Hours",
        startsAt: daysFromNow(7, 16),
        endsAt: null,
      },
    ],
    createdAt: daysAgo(600),
  },
  {
    id: "cmy_006",
    slug: "solo-founders",
    name: "Solo Founders",
    description:
      "Building alone but not in isolation — accountability, lessons learned, and the occasional vent.",
    avatarUrl: null,
    bannerUrl: null,
    category: "Startups",
    tags: ["Solo Founder", "Accountability"],
    rules: STANDARD_RULES,
    moderatorIds: [DANA.id, mockCurrentUser.id],
    memberCount: 4300,
    pinnedPostIds: ["pst_008"],
    events: [],
    createdAt: daysAgo(260),
  },
];
