import type { CommunityRole, Visibility } from "@prisma/client";

import type { UserSummaryView } from "../users/users.types.js";

/**
 * Contracts for the communities module.
 *
 * `CommunityView` mirrors the shipped frontend's `Community` type
 * (`src/types/community.ts`) key for key. The community page and the discovery
 * grid destructure exactly these names — `tags` and `rules` as flat string
 * arrays, `moderatorIds` as bare ids, `memberCount` rather than a members
 * relation — so the API has to serve this shape or the finished UI breaks.
 *
 * Three keys are additive (`visibility`, `ownerId`, `owner`); extra keys are
 * inert for the shipped components, which is the same superset argument
 * Phases 5 and 6 already make.
 */

/**
 * Mirrors the frontend's `CommunityEvent` — **four fields, nothing more**.
 *
 * `CommunityEvent` in the database also carries `description`, `isOnline`,
 * `location`, and `attendeeCount`. Only the four below are projected, because
 * `community-events.tsx` reads only these and `attendeeCount` in particular
 * cannot be maintained: there is no RSVP or attendance table anywhere in the
 * schema, and the schema is frozen (decision J10). Serving a number that no
 * write path can ever move would be inventing attendance data, so the field
 * stays out of the projection entirely rather than being reported as a
 * permanent zero.
 */
export interface CommunityEventView {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
}

/**
 * The richer event shape, for the moderator-facing CRUD surface (decision
 * J10). Separate from `CommunityEventView` on purpose: the read model the
 * public page renders and the model a moderator edits are different contracts,
 * and collapsing them would push `attendeeCount` back into the public payload.
 */
export interface CommunityEventDetailView extends CommunityEventView {
  description: string;
  isOnline: boolean;
  location: string | null;
}

/**
 * A community member. `userId` plus role, matching how Phase 5 projects
 * `ProjectMemberView` — the frontend joins ids against a people directory
 * client-side rather than expecting an embedded user.
 */
export interface CommunityMemberView {
  userId: string;
  role: CommunityRole;
  joinedAt: string;
}

/** The member list endpoint, where the embedded user saves a second request. */
export interface CommunityMemberWithUserView extends CommunityMemberView {
  user: UserSummaryView;
}

/**
 * The full community. Served only after the visibility gate resolves to
 * `full`.
 *
 * `rules` is a flat `string[]` ordered by the persisted `position` (decision
 * J11): the ordering contract lives in the response sequence, exactly as
 * Phase 5's milestones do. `moderatorIds` likewise flattens the membership
 * table down to the ids the shipped sidebar needs.
 */
export interface CommunityView {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  category: string;
  /** Flattened from `CommunityTag[] → Tag.name[]`; the frontend types this `string[]`. */
  tags: string[];
  /** Ordered by `CommunityRule.position`; the array order *is* the contract. */
  rules: string[];
  /**
   * Members holding a moderating role.
   *
   * Deliberately includes `owner` and `admin` alongside `moderator`: the
   * shipped sidebar labels this list "Moderators" and means "people who run
   * this place", and omitting the owner would show a community whose owner
   * appears to have no standing in it.
   */
  moderatorIds: string[];
  memberCount: number;
  pinnedPostIds: string[];
  events: CommunityEventView[];
  createdAt: string;

  /* ── Additive beyond the frontend's `Community` ────────────────────────── */

  /** PRD §6's three-way visibility; the frontend type predates it. */
  visibility: Visibility;
  /** Authoritative ownership source (decision J7). */
  ownerId: string;
  /** Saves the community page a second request to render the owner byline. */
  owner: UserSummaryView;
}

/**
 * The discovery-card shape.
 *
 * `community-card.tsx` reads only name, description, avatar, category, the
 * first three tags, and `memberCount`. Rules, events, pinned posts, and the
 * moderator list are all per-community sub-queries, so serving the full
 * `CommunityView` for every row of a paginated grid would fan out badly for
 * fields nothing on that screen renders.
 */
export interface CommunitySummaryView {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  category: string;
  tags: string[];
  memberCount: number;
  createdAt: string;
  visibility: Visibility;
}

/**
 * Viewer-relative state, so the community page can render the Join / Leave and
 * moderation affordances without a second round trip. The direct analogue of
 * Phase 5's `ProjectViewerState`.
 *
 * `role` is the viewer's own membership role, or `null` when they are not a
 * member. There is deliberately no field announcing *why* access was granted:
 * a viewer who can see the community does not need to know whether an admin
 * override or a public setting let them in.
 *
 * `canJoin` is computed rather than inferred from `visibility` on the client,
 * because the join rules differ per visibility (decision J5) and a client that
 * re-derived them would drift from the server that enforces them.
 */
export interface CommunityViewerState {
  isOwner: boolean;
  isMember: boolean;
  role: CommunityRole | null;
  /** False when already a member, and false for a private community (J5). */
  canJoin: boolean;
  canPost: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canModerate: boolean;
}

/** `GET /communities/:slug` — the community plus the caller's relationship. */
export interface CommunityLookupResult {
  community: CommunityView;
  /** Null for anonymous viewers: there is no relationship to describe. */
  viewer: CommunityViewerState | null;
}
