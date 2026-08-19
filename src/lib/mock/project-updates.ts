import type { ProjectUpdate } from "@/types";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** PRD.md §4.3 Project Pages "Updates" / UI_UX.md §9 "Updates" — a project's
 * own changelog, distinct from the Feed's milestone/announcement posts
 * (those are social; these are the project's own record). Keyed by
 * project id. */
export const mockProjectUpdatesByProjectId: Record<string, ProjectUpdate[]> = {
  prj_101: [
    {
      id: "upd_101_1",
      projectId: "prj_101",
      authorId: "usr_forge_001",
      content:
        "Shipped self-serve Stripe billing — no more manual invoicing for early customers.",
      createdAt: daysAgo(70),
    },
    {
      id: "upd_101_2",
      projectId: "prj_101",
      authorId: "usr_forge_001",
      content: "Public launch day. Waitlist is gone, signups are open to everyone.",
      createdAt: daysAgo(48),
    },
  ],
  prj_102: [
    {
      id: "upd_102_1",
      projectId: "prj_102",
      authorId: "usr_forge_001",
      content: "Core primitives (Button, Card, Dialog, Input) are stable and documented.",
      createdAt: daysAgo(90),
    },
    {
      id: "upd_102_2",
      projectId: "prj_102",
      authorId: "usr_005",
      content:
        "Added Select, Combobox, and Date picker — all keyboard-navigable out of the box.",
      createdAt: daysAgo(30),
    },
    {
      id: "upd_102_3",
      projectId: "prj_102",
      authorId: "usr_006",
      content: "Started drafting the v1.0 docs site. Component playground is next.",
      createdAt: daysAgo(9),
    },
  ],
  prj_001: [
    {
      id: "upd_001_1",
      projectId: "prj_001",
      authorId: "usr_003",
      content:
        "Live cursors are in — you can now see collaborators editing in real time.",
      createdAt: daysAgo(20),
    },
    {
      id: "upd_001_2",
      projectId: "prj_001",
      authorId: "usr_004",
      content: "Started work on the sprite sheet export pipeline.",
      createdAt: daysAgo(4),
    },
  ],
};
