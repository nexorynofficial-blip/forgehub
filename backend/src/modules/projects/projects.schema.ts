import { FundingStage, ProjectStatus, Visibility } from "@prisma/client";
import { z } from "zod";

import { MAX_PAGE_SIZE } from "../../utils/pagination.js";
import { MAX_SLUG_LENGTH } from "../../utils/slug.js";
import { ASSIGNABLE_MEMBER_ROLES } from "./project.access.js";

/**
 * Request validation for the projects module (BACKEND_TRD.md §15).
 *
 * What is *absent* from these schemas matters as much as what is present.
 * `slug`, `ownerId`, `progressPercent`, `viewsCount`, `likesCount`, and
 * `followersCount` appear in no write schema at all. Zod strips unknown keys,
 * so a client that posts them is not rejected — the values simply never reach
 * a repository, which is what stops a patch becoming a back door into the
 * counters. This is the same defence Phase 4 used to keep XP out of a profile
 * update.
 */

/* ── Shared field rules ──────────────────────────────────────────────────── */

/**
 * Media references (decision J10).
 *
 * Deliberately **not** `z.string().url()`. The shipped fixtures use opaque ids
 * — `mock/projects.ts` stores `"gal_1"`, and `project-gallery.tsx` renders
 * placeholder tiles rather than `<img>` — so URL validation would make the API
 * reject its own seed data. Phase 11 owns uploads and will issue real URLs;
 * until then this is a bounded string, and the bound is the point.
 */
const mediaRef = z.string().trim().min(1).max(500);

/**
 * An outbound link, restricted to `http` and `https`.
 *
 * The protocol check is not decoration. `z.string().url()` validates URL
 * *syntax*, and `javascript:alert(1)` is a syntactically valid URL — while the
 * shipped project hero renders these fields directly as
 * `<a href={project.demoUrl}>`. Without this refinement, "Live demo" is a
 * stored-XSS sink that any authenticated user can load.
 */
const httpUrl = z
  .string()
  .trim()
  .url("Enter a valid URL")
  .max(500)
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be an http or https URL" },
  );

const optionalUrl = z
  .union([httpUrl, z.literal("")])
  .transform((value) => (value === "" ? null : value))
  .nullable();

/**
 * A tag reference. Resolved against existing `Tag` rows by the service and
 * rejected when unknown (decision J7) — Phase 5 attaches to the taxonomy, it
 * does not extend it. Accepts either a display name ("Open Source") or a slug
 * ("open-source"), because the frontend's `Project.tags` holds names.
 */
const tagRef = z.string().trim().min(1).max(40);

/* ── Project create / update ─────────────────────────────────────────────── */

const projectFields = {
  title: z
    .string()
    .trim()
    .min(2, "Must be at least 2 characters")
    .max(120, "Must be at most 120 characters"),
  description: z.string().trim().max(2_000, "Keep it under 2000 characters"),
  techStack: z.array(z.string().trim().min(1).max(40)).max(30),
  tags: z.array(tagRef).max(10),
  status: z.enum(ProjectStatus),
  fundingStage: z.enum(FundingStage),
  visibility: z.enum(Visibility),
  coverImageUrl: mediaRef.nullable(),
  gallery: z.array(mediaRef).max(20),
  demoUrl: optionalUrl,
  repositoryUrl: optionalUrl,
  documentationUrl: optionalUrl,
};

/**
 * `POST /projects`.
 *
 * `title` is the only required field — the rest carry the schema's own
 * defaults, so creating a project is a one-field operation and the details can
 * follow. There is no shipped create form to mirror (the `/projects/new` route
 * constant is linked from the sidebar but the page does not exist), so this is
 * derived from BACKEND_PRD.md §6's field list.
 *
 * No `slug`: it is derived from `title` server-side and a client may not
 * choose it (decision J2).
 */
export const createProjectSchema = z.object({
  title: projectFields.title,
  description: projectFields.description.optional(),
  techStack: projectFields.techStack.optional(),
  tags: projectFields.tags.optional(),
  status: projectFields.status.optional(),
  fundingStage: projectFields.fundingStage.optional(),
  visibility: projectFields.visibility.optional(),
  coverImageUrl: projectFields.coverImageUrl.optional(),
  gallery: projectFields.gallery.optional(),
  demoUrl: projectFields.demoUrl.optional(),
  repositoryUrl: projectFields.repositoryUrl.optional(),
  documentationUrl: projectFields.documentationUrl.optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * `PATCH /projects/:slug`. Every field optional, but an empty patch is
 * rejected rather than performed as a no-op write — the Phase 4 precedent.
 *
 * `slug` is absent: renaming would break every existing link to the project,
 * and Phase 5 does not implement redirects (decision J2).
 */
export const updateProjectSchema = z
  .object({
    title: projectFields.title.optional(),
    description: projectFields.description.optional(),
    techStack: projectFields.techStack.optional(),
    tags: projectFields.tags.optional(),
    status: projectFields.status.optional(),
    fundingStage: projectFields.fundingStage.optional(),
    visibility: projectFields.visibility.optional(),
    coverImageUrl: projectFields.coverImageUrl.optional(),
    gallery: projectFields.gallery.optional(),
    demoUrl: projectFields.demoUrl.optional(),
    repositoryUrl: projectFields.repositoryUrl.optional(),
    documentationUrl: projectFields.documentationUrl.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/* ── Path parameters ─────────────────────────────────────────────────────── */

/**
 * Validated against the same charset `slugify` produces, so a malformed slug
 * is a 422 rather than a database round trip. Slug only — no UUID fallback
 * (decision J2).
 */
export const slugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(MAX_SLUG_LENGTH)
    .regex(/^[a-z0-9-]+$/, "Invalid project slug"),
});
export type SlugParam = z.infer<typeof slugParamSchema>;

/** Member sub-routes address a user by handle, as every Phase 4 route does. */
export const memberParamSchema = slugParamSchema.extend({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username")
    .toLowerCase(),
});
export type MemberParam = z.infer<typeof memberParamSchema>;

/** Child resources addressed by their own id. */
export const childParamSchema = slugParamSchema.extend({
  id: z.string().uuid("Invalid identifier"),
});
export type ChildParam = z.infer<typeof childParamSchema>;

/* ── Listing, filtering, sorting ─────────────────────────────────────────── */

/**
 * Sort keys map to indexed columns only.
 *
 * An open `sort` parameter would let a caller order by an unindexed column and
 * turn the discovery endpoint into a sequential scan. `trending` is served by
 * `projects(visibility, deletedAt, likesCount DESC)` — the composite index
 * DATABASE.md justifies specifically for this query.
 */
export const PROJECT_SORTS = ["recent", "trending", "progress", "updated"] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export const projectListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
  sort: z.enum(PROJECT_SORTS).default("recent"),
  status: z.enum(ProjectStatus).optional(),
  fundingStage: z.enum(FundingStage).optional(),
  /** Tag slug or name. */
  tag: tagRef.optional(),
  tech: z.string().trim().min(1).max(40).optional(),
});
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;

/** `GET /users/:username/projects` — also serves the "pinned" (top-liked) grid. */
export const ownerProjectsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
  sort: z.enum(PROJECT_SORTS).default("recent"),
});
export type OwnerProjectsQuery = z.infer<typeof ownerProjectsQuerySchema>;

/** The trending widget renders a fixed short list; no paging, just a cap. */
export const trendingQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(5),
});
export type TrendingQuery = z.infer<typeof trendingQuerySchema>;

/** Offset paging for the bounded child collections (members). */
export const offsetQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});
export type OffsetQuery = z.infer<typeof offsetQuerySchema>;

/** Cursor paging for the high-volume changelog. */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/* ── Members ─────────────────────────────────────────────────────────────── */

/**
 * Only the frontend's three roles are assignable (decision J4).
 *
 * The persisted enum has six, and reads return whichever is stored — but the
 * API will not mint a fourth, fifth, or sixth value, because
 * `project-team.tsx` maps exactly three and would render an empty badge for
 * the others.
 */
const assignableRole = z.enum(ASSIGNABLE_MEMBER_ROLES);

export const addMemberSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9._]+$/i, "Invalid username")
    .toLowerCase(),
  role: assignableRole.default("contributor"),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberRoleSchema = z.object({ role: assignableRole });
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;

/** `POST /projects/:slug/transfer` — owner-only, audited (decision J8). */
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

/* ── Milestones ──────────────────────────────────────────────────────────── */

/**
 * `progressPercent` is absent here and everywhere else (decision J3). It is
 * derived from these rows, so accepting it would mean a client could assert a
 * completion figure its own milestones contradict.
 */
export const createMilestoneSchema = z.object({
  title: z.string().trim().min(2, "Must be at least 2 characters").max(120),
  description: z.string().trim().max(1_000).optional(),
  isComplete: z.boolean().optional(),
  targetDate: z.coerce.date().nullable().optional(),
  position: z.number().int().min(0).max(500).optional(),
});
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = z
  .object({
    title: z.string().trim().min(2, "Must be at least 2 characters").max(120).optional(),
    description: z.string().trim().max(1_000).optional(),
    isComplete: z.boolean().optional(),
    targetDate: z.coerce.date().nullable().optional(),
    position: z.number().int().min(0).max(500).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

/* ── Updates (the project changelog) ─────────────────────────────────────── */

export const createUpdateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "An update needs some content")
    .max(5_000, "Keep it under 5000 characters"),
});
export type CreateUpdateInput = z.infer<typeof createUpdateSchema>;

export const editUpdateSchema = createUpdateSchema;
export type EditUpdateInput = z.infer<typeof editUpdateSchema>;
