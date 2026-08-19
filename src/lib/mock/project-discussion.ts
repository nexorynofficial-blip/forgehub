import type { ProjectDiscussionComment } from "@/types";
import { AMAKA, AVA, DANA, LENA, RIKO, THEO } from "@/lib/mock/people";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** UI_UX.md §9 "Discussion" / "Comments" — see docs/ASSUMPTIONS.md for why
 * both bullets are backed by this one flat thread type. Keyed by project id. */
export const mockProjectDiscussionByProjectId: Record<
  string,
  ProjectDiscussionComment[]
> = {
  prj_101: [
    {
      id: "pdc_101_1",
      projectId: "prj_101",
      author: RIKO,
      content:
        "The onboarding flow on this is so clean. Did you use a form library or roll your own?",
      likesCount: 6,
      createdAt: daysAgo(2),
    },
    {
      id: "pdc_101_2",
      projectId: "prj_101",
      author: DANA,
      content: "Would love a public roadmap for the invoicing features — any plans?",
      likesCount: 3,
      createdAt: daysAgo(1),
    },
  ],
  prj_102: [
    {
      id: "pdc_102_1",
      projectId: "prj_102",
      author: THEO,
      content:
        "The compound-variant typing pattern here is genuinely the cleanest I've seen for CVA.",
      likesCount: 14,
      createdAt: daysAgo(8),
    },
    {
      id: "pdc_102_2",
      projectId: "prj_102",
      author: LENA,
      content: "Any plans for a Figma kit to match these tokens?",
      likesCount: 9,
      createdAt: daysAgo(5),
    },
    {
      id: "pdc_102_3",
      projectId: "prj_102",
      author: AVA,
      content: "Not yet, but it's on the list once v1.0 ships!",
      likesCount: 4,
      createdAt: daysAgo(5),
    },
  ],
  prj_001: [
    {
      id: "pdc_001_1",
      projectId: "prj_001",
      author: AMAKA,
      content: "The live cursor latency is impressively low. What's the transport layer?",
      likesCount: 11,
      createdAt: daysAgo(18),
    },
  ],
};
