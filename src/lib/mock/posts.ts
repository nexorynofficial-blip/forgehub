import type { PostWithAuthor } from "@/types";
import { AMAKA, AVA, DANA, LENA, mockPeople, RIKO, THEO } from "@/lib/mock/people";

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

const AUTHORS = mockPeople;

/** Hand-authored posts covering every `PostType` (PRD.md §4.5), used to
 * exercise every card variant in Storybook-less manual QA. Padded out with
 * generated text posts below so infinite scroll has enough pages to
 * demonstrate. */
const FEATURED_POSTS: PostWithAuthor[] = [
  {
    id: "pst_001",
    authorId: DANA.id,
    author: DANA,
    projectId: "prj_002",
    type: "milestone",
    content:
      "Tidal Notes just crossed 1,000 active users. Offline-first sync was the right bet.",
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 214,
    commentsCount: 18,
    createdAt: hoursAgo(2),
  },
  {
    id: "pst_002",
    authorId: RIKO.id,
    author: RIKO,
    projectId: "prj_001",
    type: "image",
    content:
      "New layer blending modes shipped to Pixelforge. Screenshots from tonight's session:",
    mediaUrls: ["img_1", "img_2", "img_3"],
    codeSnippet: null,
    poll: null,
    likesCount: 98,
    commentsCount: 6,
    createdAt: hoursAgo(4),
  },
  {
    id: "pst_003",
    authorId: AVA.id,
    author: AVA,
    projectId: "prj_102",
    type: "code",
    content: "Finally got the compound-variant typing clean for Forge Components:",
    mediaUrls: [],
    codeSnippet: {
      language: "typescript",
      code: [
        "type ButtonVariants = VariantProps<typeof buttonVariants>;",
        "",
        "export function Button({ variant, size, ...props }: ButtonVariants) {",
        "  return <button className={buttonVariants({ variant, size })} {...props} />;",
        "}",
      ].join("\n"),
    },
    poll: null,
    likesCount: 156,
    commentsCount: 11,
    createdAt: hoursAgo(6),
  },
  {
    id: "pst_004",
    authorId: AMAKA.id,
    author: AMAKA,
    projectId: null,
    type: "poll",
    content: "Planning Ledgerline's next milestone — what should I prioritize?",
    mediaUrls: [],
    codeSnippet: null,
    poll: {
      question: "What should Ledgerline ship next?",
      options: [
        { id: "opt_1", label: "Recurring invoices", voteCount: 84 },
        { id: "opt_2", label: "Multi-currency support", voteCount: 51 },
        { id: "opt_3", label: "Client portal", voteCount: 63 },
      ],
      closesAt: hoursAgo(-48),
    },
    likesCount: 42,
    commentsCount: 9,
    createdAt: hoursAgo(9),
  },
  {
    id: "pst_005",
    authorId: THEO.id,
    author: THEO,
    projectId: null,
    type: "video",
    content: "Recorded a walkthrough of the new model benchmarking dashboard.",
    mediaUrls: ["vid_1"],
    codeSnippet: null,
    poll: null,
    likesCount: 73,
    commentsCount: 4,
    createdAt: hoursAgo(13),
  },
  {
    id: "pst_006",
    authorId: LENA.id,
    author: LENA,
    projectId: "prj_004",
    type: "update",
    content:
      "Northwind Atlas now supports layered maps for multi-floor dungeons. Small feature, huge DM quality-of-life win.",
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 61,
    commentsCount: 3,
    createdAt: hoursAgo(18),
  },
  {
    id: "pst_007",
    authorId: AVA.id,
    author: AVA,
    projectId: "prj_101",
    type: "announcement",
    content:
      "Coastline CRM is now open for public signups — no more waitlist. Link in bio.",
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 302,
    commentsCount: 27,
    createdAt: hoursAgo(24),
  },
  {
    id: "pst_008",
    authorId: DANA.id,
    author: DANA,
    projectId: null,
    type: "markdown",
    content:
      "**Lesson learned this week:** CRDTs are easy to explain and hard to debug at 2am. Wrote up the merge-conflict edge case that took me three days to track down — full post on the blog.",
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 187,
    commentsCount: 15,
    createdAt: hoursAgo(30),
  },
  {
    id: "pst_009",
    authorId: RIKO.id,
    author: RIKO,
    projectId: null,
    type: "text",
    content:
      'Reminder that "done" is a feature. Shipped the sprite export tool I\'ve been sitting on for two months out of perfectionism.',
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 445,
    commentsCount: 34,
    createdAt: hoursAgo(36),
  },
  {
    id: "pst_010",
    authorId: THEO.id,
    author: THEO,
    projectId: null,
    type: "milestone",
    content:
      "Hit 10,000 inference requests on the benchmark API this month without a single p99 regression.",
    mediaUrls: [],
    codeSnippet: null,
    poll: null,
    likesCount: 129,
    commentsCount: 8,
    createdAt: hoursAgo(48),
  },
];

function buildFillerPosts(count: number): PostWithAuthor[] {
  const templates = [
    "Small refactor today: extracted the retry logic into its own hook. Felt good.",
    "Debugging a race condition for three hours to find a missing await. Every time.",
    "Design review went well — shipping the new empty states next week.",
    "Wrote tests for the edge cases I was avoiding. No regrets, but also, regrets.",
    "Today's build-in-public update: nothing broke, which is its own kind of milestone.",
    "Swapped our polling loop for a proper event queue. Latency down 40%.",
    "Found a great pattern for optimistic UI updates — writing it up soon.",
    "Pair-programmed with a collaborator for the first time on this project. More of this.",
  ];

  return Array.from({ length: count }, (_, i) => {
    const author = AUTHORS[i % AUTHORS.length];
    return {
      id: `pst_fill_${i + 1}`,
      authorId: author.id,
      author,
      projectId: null,
      type: "text",
      content: templates[i % templates.length],
      mediaUrls: [],
      codeSnippet: null,
      poll: null,
      likesCount: 12 + ((i * 7) % 60),
      commentsCount: (i * 3) % 12,
      createdAt: hoursAgo(54 + i * 5),
    } satisfies PostWithAuthor;
  });
}

export const mockPosts: PostWithAuthor[] = [...FEATURED_POSTS, ...buildFillerPosts(20)];

/** Authors treated as "followed" by the current user, for the Following filter. */
export const mockFollowedAuthorIds = new Set([DANA.id, RIKO.id, LENA.id]);
