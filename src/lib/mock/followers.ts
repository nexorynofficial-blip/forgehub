import type { FollowerPreview } from "@/types";

/** Shared follower-preview pool reused across profiles for this demo — see
 * docs/ASSUMPTIONS.md (Phase 05). */
export const mockFollowerPreviews: FollowerPreview[] = [
  { id: "flw_001", username: "lena.b", displayName: "Lena Brandt", avatarUrl: null },
  { id: "flw_002", username: "theo.m", displayName: "Theo Marchetti", avatarUrl: null },
  { id: "flw_003", username: "amaka.c", displayName: "Amaka Chukwu", avatarUrl: null },
  { id: "flw_004", username: "sofia.a", displayName: "Sofia Álvarez", avatarUrl: null },
  { id: "flw_005", username: "jules.f", displayName: "Jules Fontaine", avatarUrl: null },
  {
    id: "flw_006",
    username: "priya.n",
    displayName: "Priya Nandakumar",
    avatarUrl: null,
  },
  { id: "flw_007", username: "kenji.o", displayName: "Kenji Osei", avatarUrl: null },
  { id: "flw_008", username: "maya.p", displayName: "Maya Petrova", avatarUrl: null },
];
