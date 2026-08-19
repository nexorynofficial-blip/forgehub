import type { Report } from "@/types";
import { AMAKA, AVA, DANA, LENA, RIKO, THEO } from "@/lib/mock/people";

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

/** `Report` fixtures (TRD.md §4). Targets reference real content from
 * earlier phases (mock/posts.ts, mock/comments.ts, mock/communities.ts,
 * mock/projects.ts) rather than inventing disconnected ids — see
 * docs/ASSUMPTIONS.md (Phase 11). */
export const mockReports: Report[] = [
  {
    id: "rpt_001",
    reporterId: LENA.id,
    targetType: "post",
    targetId: "pst_004",
    targetAuthorId: AMAKA.id,
    reason: "spam",
    details: "This poll has been reposted identically in three communities today.",
    status: "pending",
    createdAt: hoursAgo(3),
  },
  {
    id: "rpt_002",
    reporterId: DANA.id,
    targetType: "user",
    targetId: THEO.id,
    targetAuthorId: THEO.id,
    reason: "harassment",
    details:
      "Repeated dismissive comments across multiple threads directed at one person.",
    status: "pending",
    createdAt: hoursAgo(9),
  },
  {
    id: "rpt_003",
    reporterId: AVA.id,
    targetType: "comment",
    targetId: "cmt_003",
    targetAuthorId: AMAKA.id,
    reason: "other",
    details: "Off-topic and unrelated to the discussion thread.",
    status: "pending",
    createdAt: hoursAgo(20),
  },
  {
    id: "rpt_004",
    reporterId: THEO.id,
    targetType: "project",
    targetId: "prj_002",
    targetAuthorId: DANA.id,
    reason: "impersonation",
    details: "Claims affiliation with a company that has denied any connection.",
    status: "dismissed",
    createdAt: hoursAgo(72),
  },
  {
    id: "rpt_005",
    reporterId: RIKO.id,
    targetType: "community",
    targetId: "cmy_004",
    targetAuthorId: null,
    reason: "inappropriate_content",
    details: "Pinned post links to an unrelated external product.",
    status: "resolved",
    createdAt: hoursAgo(140),
  },
  {
    id: "rpt_006",
    reporterId: LENA.id,
    targetType: "post",
    targetId: "pst_fill_3",
    targetAuthorId: RIKO.id,
    reason: "spam",
    details: "Low-effort filler content posted in a burst.",
    status: "resolved",
    createdAt: hoursAgo(200),
  },
];
