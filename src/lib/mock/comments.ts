import type { CommentWithAuthor } from "@/types";
import { AMAKA, AVA, RIKO } from "@/lib/mock/people";

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** Comments for a subset of `mockPosts` (mock/posts.ts) — posts not listed
 * here simply have none yet. Keyed by post id. */
export const mockCommentsByPostId: Record<string, CommentWithAuthor[]> = {
  pst_001: [
    {
      id: "cmt_001",
      postId: "pst_001",
      authorId: AVA.id,
      author: AVA,
      parentCommentId: null,
      content: "Huge congrats — offline-first was the hard way to do it and it shows.",
      likesCount: 12,
      createdAt: hoursAgo(1.5),
    },
    {
      id: "cmt_002",
      postId: "pst_001",
      authorId: RIKO.id,
      author: RIKO,
      parentCommentId: null,
      content: "What's your sync conflict rate looking like at this scale?",
      likesCount: 4,
      createdAt: hoursAgo(1),
    },
  ],
  pst_003: [
    {
      id: "cmt_003",
      postId: "pst_003",
      authorId: AMAKA.id,
      author: AMAKA,
      parentCommentId: null,
      content: "Clean. Stealing this pattern for Ledgerline's button variants.",
      likesCount: 8,
      createdAt: hoursAgo(5),
    },
  ],
  pst_007: [
    {
      id: "cmt_004",
      postId: "pst_007",
      authorId: RIKO.id,
      author: RIKO,
      parentCommentId: null,
      content: "Signed up immediately. The onboarding flow is so smooth.",
      likesCount: 21,
      createdAt: hoursAgo(20),
    },
    {
      id: "cmt_005",
      postId: "pst_007",
      authorId: AMAKA.id,
      author: AMAKA,
      parentCommentId: null,
      content: "Congrats on the launch! How long was the waitlist?",
      likesCount: 6,
      createdAt: hoursAgo(19),
    },
  ],
  pst_009: [
    {
      id: "cmt_006",
      postId: "pst_009",
      authorId: AVA.id,
      author: AVA,
      parentCommentId: null,
      content: '"Done is a feature" is going on a sticky note on my monitor.',
      likesCount: 34,
      createdAt: hoursAgo(30),
    },
  ],
};
