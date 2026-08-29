import { Visibility } from "@prisma/client";
import { z } from "zod";

import { MAX_PAGE_SIZE } from "../../utils/pagination.js";
import { MAX_SLUG_LENGTH } from "../../utils/slug.js";
import { ASSIGNABLE_COMMUNITY_ROLES } from "./community.access.js";

/**
 * Request validation for the communities module (BACKEND_TRD.md §15).
 *
 * What is *absent* from these schemas matters as much as what is present.
 * `slug`, `ownerId`, `memberCount`, and every timestamp appear in no write
 * schema at all. Zod strips unknown keys, so a client that posts them is not
 * rejected — the values simply never reach a repository, which is what stops a
 * patch becoming a back door into the counters. The same defence Phases 4–6
 * used to keep XP, `progressPercent`, and `likesCount` out of update bodies.
 *
 * `attendeeCount` is absent for a different reason: no RSVP model exists, so
 * there is no writer for it and never a reason to accept one (decision J10).
 */

/* ── Shared field rules ──────────────────────────────────────────────────── */

/**
 * Media references.
 *
 * Deliberately **not** `z.string().url()`, matching the Phase 5 precedent: the
 * shipped fixtures use opaque ids rather than URLs, so URL validation would
 * make the API reject its own seed data. Phase 11 owns uploads and will issue
 * real URLs; until then this is a bounded string, and the bound is the point.
 */
const mediaRef = z.string().trim().min(1).max(500);

/**
 * A tag reference. Resolved against existing `Tag` rows by the service and
 * rejected when unknown (decision J8) — Phase 7 attaches to the taxonomy, it
 * does not extend it. Accepts either a display name ("Open Source") or a slug
 * ("open-source"), because the frontend's `Community.tags` holds names.
 */
const tagRef = z.string().trim().min(1).max(40);

/**
 * The community's single primary category (decision J9).
 *
 * A permissive bounded string, **not** an enum. `community-discovery.tsx`
 * builds its filter tabs from the distinct set of categories actually present
 * in the data, so an enum would not merely constrain new communities — it would
 * silently drop any seeded value that fell outside it, and the seed already
 * ships "Artificial Intelligence", "Design", and "Startups". Trimmed,
 * non-empty, and length-capped is the whole contract.
 */
const category = z
  .string()
  .trim()
  .min(1, "Choose a category")
  .max(60, "Must be at most 60 characters");

/* ── Community create / update ───────────────────────────────────────────── */

const communityFields = {
  name: z
    .string()
    .trim()
    .min(2, "Must be at least 2 characters")
    .max(80, "Must be at most 80 characters"),
  description: z.string().trim().max(2_000, "Keep it under 2000 characters"),
  category,
  tags: z.array(tagRef).max(10),
  visibility: z.enum(Visibility),
  avatarUrl: mediaRef.nullable(),
  bannerUrl: mediaRef.nullable(),
};

/**
 * `POST /communities`.
 *
 * `name` and `category` are the required pair: a community with no category
 * would be unreachable through the discovery tabs that are the only way the
 * shipped UI browses them, so defaulting it would produce a community nobody
 * can find.
 *
 * No `slug`: it is derived from `name` server-side and a client may not choose
 * it (the Phase 5 J2 precedent, reusing the same `slugify`).
 *
 * No `rules` and no `ownerId`. Rules are managed through their own replace-set
 * route (decision J11), and the owner is always the authenticated caller.
 */
export const createCommunitySchema = z.object({
  name: communityFields.name,
  category: communityFields.category,
  description: communityFields.description.optional(),
  tags: communityFields.tags.optional(),
  visibility: communityFields.visibility.optional(),
  avatarUrl: communityFields.avatarUrl.optional(),
  bannerUrl: communityFields.bannerUrl.optional(),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;

/**
 * `PATCH /communities/:slug`. Every field optional, but an empty patch is
 * rejected rather than performed as a no-op write — the Phase 4 precedent.
 *
 * `slug` is absent: renaming would break every existing link to the community,
 * and Phase 7 does not implement redirects. The frontend routes
 * `/communities/[communityId]` on the slug, so a mutable slug would break
 * bookmarks silently.
 */
export const updateCommunitySchema = z
  .object({
    name: communityFields.name.optional(),
    description: communityFields.description.optional(),
    category: communityFields.category.optional(),
    tags: communityFields.tags.optional(),
    visibility: communityFields.visibility.optional(),
    avatarUrl: communityFields.avatarUrl.optional(),
    bannerUrl: communityFields.bannerUrl.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;

/* ── Rules (decision J11) ────────────────────────────────────────────────── */

/**
 * `PUT /communities/:slug/rules` — replace-set semantics.
 *
 * The whole ordered list is submitted at once and the array index becomes
 * `CommunityRule.position`. Per-rule CRUD was rejected because the frontend
 * contract is a flat `string[]`: a client that can only send the list back has
 * no id to address a single rule with, and reordering through individual
 * patches would need a position-shuffling protocol for no gain.
 *
 * An empty array is valid — it clears the rules, which is a real thing a
 * community may want and is distinct from "provide at least one field".
 */
export const replaceRulesSchema = z.object({
  rules: z
    .array(
      z
        .string()
        .trim()
        .min(1, "A rule cannot be empty")
        .max(500, "Keep each rule under 500 characters"),
    )
    .max(30, "At most 30 rules"),
});

export type ReplaceRulesInput = z.infer<typeof replaceRulesSchema>;

/**
 * `PUT /communities/:slug/tags` — replace-set, same shape as rules.
 *
 * A dedicated route rather than only the PATCH field, so a client changing tags
 * does not have to send a whole community patch alongside — and so the
 * replacement lands in a transaction of its own.
 */
export const replaceTagsSchema = z.object({
  tags: z.array(tagRef).max(10),
});

export type ReplaceTagsInput = z.infer<typeof replaceTagsSchema>;

/* ── Events (decision J10) ───────────────────────────────────────────────── */

const eventFields = {
  title: z
    .string()
    .trim()
    .min(2, "Must be at least 2 characters")
    .max(140, "Must be at most 140 characters"),
  description: z.string().trim().max(2_000, "Keep it under 2000 characters"),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable(),
  isOnline: z.boolean(),
  location: z.string().trim().max(200).nullable(),
};

/**
 * The end must not precede the start.
 *
 * Expressed as a shared refinement so create and update enforce it
 * identically. On update both fields are optional, so the check only fires
 * when the request carries enough information to decide — a patch that moves
 * only `startsAt` is validated against the stored `endsAt` in the service,
 * where the existing row is available.
 */
function endsAfterStart(data: {
  // `| undefined` is explicit because `exactOptionalPropertyTypes` otherwise
  // reads `startsAt?: Date` as "absent or a Date, never undefined", which a
  // parsed optional field does not satisfy.
  startsAt?: Date | undefined;
  endsAt?: Date | null | undefined;
}): boolean {
  if (data.startsAt === undefined) return true;
  if (data.endsAt === undefined || data.endsAt === null) return true;
  return data.endsAt.getTime() >= data.startsAt.getTime();
}

/** Not `as const`: Zod types `path` as a mutable `PropertyKey[]`. */
const ENDS_AFTER_START = {
  message: "The event cannot end before it starts",
  path: ["endsAt"] as PropertyKey[],
};

export const createEventSchema = z
  .object({
    title: eventFields.title,
    startsAt: eventFields.startsAt,
    description: eventFields.description.optional(),
    endsAt: eventFields.endsAt.optional(),
    isOnline: eventFields.isOnline.optional(),
    location: eventFields.location.optional(),
  })
  .refine(endsAfterStart, ENDS_AFTER_START);

export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z
  .object({
    title: eventFields.title.optional(),
    description: eventFields.description.optional(),
    startsAt: eventFields.startsAt.optional(),
    endsAt: eventFields.endsAt.optional(),
    isOnline: eventFields.isOnline.optional(),
    location: eventFields.location.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  })
  .refine(endsAfterStart, ENDS_AFTER_START);

export type UpdateEventInput = z.infer<typeof updateEventSchema>;

/* ── Members ─────────────────────────────────────────────────────────────── */

/**
 * Adding a member directly, and changing an existing member's role.
 *
 * `owner` is absent from `ASSIGNABLE_COMMUNITY_ROLES` by construction:
 * ownership moves only through the audited transfer, never by assigning a role
 * (decision J7).
 */
export const memberRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_COMMUNITY_ROLES),
});

export type MemberRoleInput = z.infer<typeof memberRoleSchema>;

/** Adding a member by handle; role optional and defaulted by the service. */
export const addMemberSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username")
    .toLowerCase(),
  role: z.enum(ASSIGNABLE_COMMUNITY_ROLES).optional(),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;

/** `POST /communities/:slug/transfer` — ownership transfer (decision J7). */
export const transferOwnershipSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username")
    .toLowerCase(),
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

/* ── Pinned posts (decision J14) ─────────────────────────────────────────── */

/**
 * `POST /communities/:slug/pins`.
 *
 * The post must already belong to this community; that is a service check
 * against the stored row, not something a schema can assert.
 */
export const pinPostSchema = z.object({
  postId: z.string().uuid("Invalid identifier"),
});

export type PinPostInput = z.infer<typeof pinPostSchema>;

/* ── Path parameters ─────────────────────────────────────────────────────── */

/**
 * Validated against the same charset `slugify` produces, so a malformed slug
 * is a 422 rather than a database round trip. Slug only — no UUID fallback,
 * matching Phase 5 and the frontend's `[communityId]` segment, which the page
 * resolves via `getCommunityBySlug`.
 */
export const communitySlugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SLUG_LENGTH)
    .regex(/^[a-z0-9-]+$/, "Invalid community slug"),
});
export type CommunitySlugParam = z.infer<typeof communitySlugParamSchema>;

/** Member sub-routes address a user by handle, as every Phase 4 route does. */
export const communityMemberParamSchema = communitySlugParamSchema.extend({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username")
    .toLowerCase(),
});
export type CommunityMemberParam = z.infer<typeof communityMemberParamSchema>;

/** Child resources addressed by their own id (events, pins). */
export const communityChildParamSchema = communitySlugParamSchema.extend({
  id: z.string().uuid("Invalid identifier"),
});
export type CommunityChildParam = z.infer<typeof communityChildParamSchema>;

/* ── Listing, filtering, sorting (decision J12) ──────────────────────────── */

/**
 * Sort keys map to indexed columns only.
 *
 * An open `sort` parameter would let a caller order by an unindexed column and
 * turn discovery into a sequential scan. `recent` is served by
 * `communities(createdAt DESC)`; `members` orders by the denormalized
 * `memberCount`, which is exactly why that counter is denormalized.
 */
export const COMMUNITY_SORTS = ["recent", "members"] as const;
export type CommunitySort = (typeof COMMUNITY_SORTS)[number];

/**
 * `GET /communities` — cursor-paginated discovery.
 *
 * Cursor rather than offset (decision J12): the discovery grid is an
 * append-heavy list, and offset paging drifts as communities are created
 * mid-scroll. The shipped `getCommunities()` fetches everything and filters in
 * the browser, which keeps working — it simply reads the first page — while
 * `category` and `q` let a client that outgrows that push the work server-side.
 */
export const communityListQuerySchema = z.object({
  cursor: z.string().uuid("Invalid cursor").optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
  sort: z.enum(COMMUNITY_SORTS).default("recent"),
  category: category.optional(),
  /** Free-text search across name and description. */
  q: z.string().trim().min(1).max(100).optional(),
});
export type CommunityListQuery = z.infer<typeof communityListQuerySchema>;

/** Cursor paging for child collections (members, posts, pins). */
export const communityCursorQuerySchema = z.object({
  cursor: z.string().uuid("Invalid cursor").optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});
export type CommunityCursorQuery = z.infer<typeof communityCursorQuerySchema>;

/**
 * Upcoming events. The dashboard widget renders a fixed short list, so this is
 * a cap rather than a page — the same shape Phase 5 gave its trending widget.
 */
export const eventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(10),
  /** Include events whose `startsAt` has passed. */
  includePast: z.coerce.boolean().default(false),
});
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
