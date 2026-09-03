import type { ID, ISODateString, UserRole } from "./common";
import type { User } from "./user";

/**
 * Presentation-layer types for the profile page (Phase 05), same convention
 * as src/types/marketing.ts and src/types/dashboard.ts.
 */

export interface ContributionDay {
  date: ISODateString;
  count: number;
}

export interface FollowerPreview {
  id: ID;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/* ── Someone else's profile ───────────────────────────────────────────────── */

/**
 * Viewing another profile is not the same as reading your own, and the backend
 * says so in two ways this type has to carry honestly.
 *
 * 1. **Email may be withheld.** `User.email` is a required string because on
 *    your *own* record it always exists. On someone else's it is `null` unless
 *    they opted into `showEmailOnProfile`, so `PublicUser` widens exactly that
 *    one field rather than making it optional everywhere.
 * 2. **The whole profile may be withheld.** A followers-only profile seen by a
 *    non-follower comes back as an identity shell with `restricted: true`.
 *
 * Modelled as a discriminated union on `restricted` — the same discriminant the
 * backend's `RedactedUserView` sets — so a component cannot read `bio` off a
 * restricted profile without TypeScript stopping it. That is the point: the
 * old mock always had every field, and nothing but the type system prevents a
 * component from assuming that still holds.
 */
export type PublicUser = Omit<User, "email"> & {
  email: string | null;
  restricted?: false;
};

/**
 * What a non-follower sees of a followers-only profile.
 *
 * Identity and aggregate counters only. Bio, skills, tech stack, social links,
 * experience, achievements, badges and reputation detail are absent — not
 * empty, absent — because the server never sent them.
 */
export interface RestrictedUser {
  id: ID;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  role: UserRole;
  builderRank: string;
  followersCount: number;
  followingCount: number;
  projectsCount: number;
  createdAt: ISODateString;
  restricted: true;
}

export type ProfileUser = PublicUser | RestrictedUser;

/** Narrowing helper, so call sites read as a question rather than a flag check. */
export function isRestrictedProfile(user: ProfileUser): user is RestrictedUser {
  return user.restricted === true;
}

/**
 * The viewer's relationship to the profile, returned alongside it so the
 * header can render the follow button without a second round trip.
 *
 * `null` for anonymous viewers. There is deliberately no `isBlockedBy`: a
 * profile whose owner blocked you resolves to 404, so a field announcing it
 * would be a disclosure.
 */
export interface ProfileRelationship {
  isSelf: boolean;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isBlocking: boolean;
}

export interface ProfileResult {
  user: ProfileUser;
  relationship: ProfileRelationship | null;
}
