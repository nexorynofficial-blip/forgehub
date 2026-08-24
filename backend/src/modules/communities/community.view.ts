import { toUserSummary } from "../users/user.view.js";
import { MODERATING_ROLES } from "./community.access.js";
import type {
  CommunityDetailRow,
  CommunityEventRow,
  CommunityMemberRow,
  CommunitySummaryRow,
} from "./communities.repository.js";
import type {
  CommunityEventDetailView,
  CommunityEventView,
  CommunityMemberView,
  CommunityMemberWithUserView,
  CommunitySummaryView,
  CommunityView,
} from "./communities.types.js";

/**
 * The projection layer for communities.
 *
 * Nothing outside this file turns a Prisma row into an API response. That is
 * the whole point, and it is the same chokepoint discipline `user.view.ts`,
 * `project.view.ts`, and `post.view.ts` established: "can this endpoint leak a
 * column it shouldn't?" has one place to check rather than one per controller.
 *
 * Columns the repository selects and this layer deliberately never emits:
 *
 *   - **`deletedAt`** — read by the visibility gate, but emitting it would let
 *     a client distinguish "soft-deleted" from "never existed", which is
 *     precisely the distinction the 404 exists to erase.
 *   - **`CommunityEvent.attendeeCount`** — no RSVP model exists, so no write
 *     path can ever move it (decision J10). It stays server-side rather than
 *     being reported as a permanent zero, which would read as "nobody is
 *     attending" instead of "attendance does not exist here".
 *   - **Everything on the nested owner beyond `UserSummaryView`** — the owner
 *     is projected through `toUserSummary`, which carries no email, no
 *     `passwordHash`, and no settings, rather than through a hand-assembled
 *     object.
 *
 * Every projection builds its result **by construction**. None of them starts
 * from a row and deletes keys: an omission list starts leaking the day someone
 * adds a column, whereas adding a field to an explicit shape has to be
 * deliberate.
 */

function toIso(value: Date): string {
  return value.toISOString();
}

function toIsoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/* ── Children ────────────────────────────────────────────────────────────── */

/**
 * The public event shape — four fields.
 *
 * `description`, `isOnline`, `location`, and `attendeeCount` are all selected
 * by the repository and none of them appear here, because
 * `community-events.tsx` reads only these four. The richer shape is served by
 * the moderator-facing detail projection below.
 */
export function toCommunityEvent(row: CommunityEventRow): CommunityEventView {
  return {
    id: row.id,
    title: row.title,
    startsAt: toIso(row.startsAt),
    endsAt: toIsoOrNull(row.endsAt),
  };
}

/**
 * The moderator-facing event.
 *
 * Still no `attendeeCount`: a moderator cannot move it either, so exposing it
 * on an editable resource would invite a client to send it back.
 */
export function toCommunityEventDetail(row: CommunityEventRow): CommunityEventDetailView {
  return {
    ...toCommunityEvent(row),
    description: row.description,
    isOnline: row.isOnline,
    location: row.location,
  };
}

/**
 * The embedded member entry. `userId` only — no nested user — matching how the
 * frontend joins ids against a people directory client-side.
 *
 * `role` is emitted verbatim. Reporting an `admin` as a `moderator` to make a
 * badge render would be lying about authorization state.
 */
export function toCommunityMember(row: {
  userId: string;
  role: CommunityMemberView["role"];
  joinedAt: Date;
}): CommunityMemberView {
  return { userId: row.userId, role: row.role, joinedAt: toIso(row.joinedAt) };
}

/** The joined member, for the members endpoint. */
export function toCommunityMemberWithUser(
  row: CommunityMemberRow,
): CommunityMemberWithUserView {
  return {
    userId: row.userId,
    role: row.role,
    joinedAt: toIso(row.joinedAt),
    user: toUserSummary(row.user),
  };
}

/* ── The community ───────────────────────────────────────────────────────── */

/**
 * The full community.
 *
 * Three relations are flattened to the arrays the frontend types:
 *
 *   - **`tags`** — `CommunityTag → Tag.name[]`, the display name rather than
 *     the slug, because `community-card.tsx` renders these as badge labels.
 *   - **`rules`** — `CommunityRule.content[]` in `position` order. The
 *     repository does the ordering; the array sequence *is* the contract, the
 *     same way Phase 5 handles milestones.
 *   - **`moderatorIds`** — members holding a moderating role. Includes owner
 *     and admin, not only `moderator`: the shipped sidebar labels this list
 *     "Moderators" and means "people who run this place".
 *
 * `memberCount` is read from the denormalized column rather than counted from
 * the `members` array, because the detail select does not carry every member —
 * only the moderating ones. Counting the array would silently report a
 * community of three thousand as a community of four.
 */
export function toCommunityView(row: CommunityDetailRow): CommunityView {
  const moderatorIds = row.members
    .filter((member) => (MODERATING_ROLES as readonly string[]).includes(member.role))
    .map((member) => member.userId);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatarUrl,
    bannerUrl: row.bannerUrl,
    category: row.category,
    tags: row.tags.map((link) => link.tag.name),
    rules: row.rules.map((rule) => rule.content),
    moderatorIds,
    memberCount: row.memberCount,
    pinnedPostIds: row.pinnedPosts.map((pin) => pin.postId),
    events: row.events.map(toCommunityEvent),
    createdAt: toIso(row.createdAt),

    /* Additive beyond the frontend's `Community`. */
    visibility: row.visibility,
    ownerId: row.ownerId,
    owner: toUserSummary(row.owner),
  };
}

/**
 * The discovery-card shape.
 *
 * Deliberately not `toCommunityView`: rules, events, pinned posts, and the
 * moderator list are per-community sub-queries, and fanning them out for every
 * row of a paginated grid would be expensive for fields that screen does not
 * render.
 */
export function toCommunitySummary(row: CommunitySummaryRow): CommunitySummaryView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatarUrl,
    bannerUrl: row.bannerUrl,
    category: row.category,
    tags: row.tags.map((link) => link.tag.name),
    memberCount: row.memberCount,
    createdAt: toIso(row.createdAt),
    visibility: row.visibility,
  };
}
