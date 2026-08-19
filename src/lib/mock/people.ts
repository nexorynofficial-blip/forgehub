import type { PostAuthor } from "@/types";
import { mockCurrentUser } from "@/lib/mock/users";

/**
 * Canonical lightweight-person fixtures, shared by every feature that needs
 * a name/avatar/rank without a full `User` record (feed authors, comment
 * authors, project team members, ...). `PostAuthor` (types/feed.ts) is the
 * shape's original name — it's grown beyond just post authors, same as
 * `ActivityItem` growing beyond the landing page. Previously duplicated
 * ad-hoc in mock/posts.ts and mock/comments.ts; consolidated here in
 * Phase 07 so a third consumer (project teams) doesn't add a fourth copy.
 */
export const AVA: PostAuthor = {
  id: "usr_forge_001",
  username: "ava.codes",
  displayName: "Ava Whitfield",
  avatarUrl: null,
  builderRank: "Architect",
};
export const DANA: PostAuthor = {
  id: "usr_002",
  username: "dana.builds",
  displayName: "Dana Okafor",
  avatarUrl: null,
  builderRank: "Visionary",
};
export const RIKO: PostAuthor = {
  id: "usr_003",
  username: "riko.tanaka",
  displayName: "Riko Tanaka",
  avatarUrl: null,
  builderRank: "Architect",
};
export const AMAKA: PostAuthor = {
  id: "usr_004",
  username: "amaka.c",
  displayName: "Amaka Chukwu",
  avatarUrl: null,
  builderRank: "Craftsperson",
};
export const THEO: PostAuthor = {
  id: "usr_005",
  username: "theo.m",
  displayName: "Theo Marchetti",
  avatarUrl: null,
  builderRank: "Craftsperson",
};
export const LENA: PostAuthor = {
  id: "usr_006",
  username: "lena.b",
  displayName: "Lena Brandt",
  avatarUrl: null,
  builderRank: "Craftsperson",
};

export const mockPeople = [AVA, DANA, RIKO, AMAKA, THEO, LENA];

export const mockPeopleById: Record<string, PostAuthor> = Object.fromEntries(
  mockPeople.map((person) => [person.id, person]),
);

/** Resolves any userId to a lightweight person, checking `mockCurrentUser`
 * first since it isn't itself in the `mock/people.ts` directory — shared by
 * every service that joins a userId-only field (project members/updates,
 * community moderators) against a display-ready person. */
export function resolvePersonById(userId: string): PostAuthor | null {
  return userId === mockCurrentUser.id
    ? mockCurrentUser
    : (mockPeopleById[userId] ?? null);
}
