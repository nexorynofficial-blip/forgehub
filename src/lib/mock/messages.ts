import type { Message } from "@/types";
import { DANA, LENA, THEO } from "@/lib/mock/people";
import { mockCurrentUser } from "@/lib/mock/users";

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const AVA_ID = mockCurrentUser.id;

/** Message threads (TRD.md §4), keyed by conversation id. The last entry
 * per thread matches `mock/conversations.ts`' dashboard-derived preview
 * text/unread state exactly — see docs/ASSUMPTIONS.md (Phase 09). Messages
 * not yet seen by everyone (the "unread" tail) omit the missing
 * participant from `seenByUserIds`. */
export const mockMessagesByConversationId: Record<string, Message[]> = {
  cvo_001: [
    {
      id: "msg_001_1",
      conversationId: "cvo_001",
      senderId: DANA.id,
      content: "Hey, quick one — did you see the sync conflict on the CRDT merge?",
      attachments: [],
      seenByUserIds: [AVA_ID, DANA.id],
      createdAt: minutesAgo(2900),
    },
    {
      id: "msg_001_2",
      conversationId: "cvo_001",
      senderId: AVA_ID,
      content: "Not yet, was heads down on Coastline. Got a link?",
      attachments: [],
      seenByUserIds: [AVA_ID, DANA.id],
      createdAt: minutesAgo(2880),
    },
    {
      id: "msg_001_3",
      conversationId: "cvo_001",
      senderId: DANA.id,
      content: "Here's the branch — looks like a race on concurrent edits.",
      attachments: [
        { id: "att_001", url: "#", type: "file", name: "sync-conflict-repro.md" },
      ],
      seenByUserIds: [AVA_ID, DANA.id],
      createdAt: minutesAgo(1400),
    },
    {
      id: "msg_001_4",
      conversationId: "cvo_001",
      senderId: DANA.id,
      content: "Can you take a look at the sync conflict PR?",
      attachments: [],
      seenByUserIds: [DANA.id],
      createdAt: minutesAgo(12),
    },
  ],
  cvo_002: [
    {
      id: "msg_002_1",
      conversationId: "cvo_002",
      senderId: AVA_ID,
      content: "Just shipped the new onboarding flow, curious what you think!",
      attachments: [],
      seenByUserIds: [AVA_ID, LENA.id],
      createdAt: minutesAgo(200),
    },
    {
      id: "msg_002_2",
      conversationId: "cvo_002",
      senderId: LENA.id,
      content: "Loved the new onboarding flow 🎉",
      attachments: [],
      seenByUserIds: [AVA_ID, LENA.id],
      createdAt: minutesAgo(95),
    },
  ],
  cvo_003: [
    {
      id: "msg_003_1",
      conversationId: "cvo_003",
      senderId: AVA_ID,
      content: "How's the benchmark suite coming along?",
      attachments: [],
      seenByUserIds: [AVA_ID, THEO.id],
      createdAt: minutesAgo(600),
    },
    {
      id: "msg_003_2",
      conversationId: "cvo_003",
      senderId: THEO.id,
      content: "Almost done, results are looking really good so far.",
      attachments: [],
      seenByUserIds: [AVA_ID, THEO.id],
      createdAt: minutesAgo(500),
    },
    {
      id: "msg_003_3",
      conversationId: "cvo_003",
      senderId: THEO.id,
      content: "Sent over the model benchmarks",
      attachments: [{ id: "att_002", url: "#", type: "file", name: "benchmarks-q3.csv" }],
      seenByUserIds: [THEO.id],
      createdAt: minutesAgo(340),
    },
  ],
  cvo_004: [
    {
      id: "msg_004_1",
      conversationId: "cvo_004",
      senderId: THEO.id,
      content: "Just added the Select component, keyboard nav included.",
      attachments: [],
      seenByUserIds: [AVA_ID, THEO.id, LENA.id],
      createdAt: minutesAgo(43200),
    },
    {
      id: "msg_004_2",
      conversationId: "cvo_004",
      senderId: LENA.id,
      content: "Nice! I'll start drafting the docs site copy.",
      attachments: [],
      seenByUserIds: [AVA_ID, THEO.id, LENA.id],
      createdAt: minutesAgo(43100),
    },
    {
      id: "msg_004_3",
      conversationId: "cvo_004",
      senderId: AVA_ID,
      content: "Great work both of you 🙌",
      attachments: [],
      seenByUserIds: [AVA_ID, THEO.id, LENA.id],
      createdAt: minutesAgo(43000),
    },
  ],
};
