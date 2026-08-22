import { MediaType, PostType, Visibility } from "@prisma/client";
import { z } from "zod";

import { MAX_PAGE_SIZE } from "../../utils/pagination.js";

/**
 * Request validation for the posts module (BACKEND_TRD.md §15).
 *
 * What is absent matters as much as what is present. `authorId`, `likesCount`,
 * `commentsCount`, and every timestamp appear in no write schema, so a client
 * that posts them is not rejected — Zod strips unknown keys and the values
 * never reach a repository. `communityId` is absent for a different reason:
 * decision J9 refuses community posts outright in this phase.
 */

/**
 * Media must be a real `http`/`https` URL (decision J11).
 *
 * `z.string().url()` alone accepts `javascript:alert(1)`, which is a
 * syntactically valid URL, and media URLs are rendered into the DOM. This is
 * the same protocol guard Phase 5 applied to `demoUrl` — and deliberately
 * *stricter* than Phase 5's `gallery`, which had to stay permissive because
 * the shipped fixtures store opaque ids. The post fixtures use empty arrays,
 * so nothing forces the looser rule here.
 */
const mediaUrl = z
  .string()
  .trim()
  .url("Enter a valid URL")
  .max(2_000)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "Must be an http or https URL" },
  );

const mediaItemSchema = z.object({
  url: mediaUrl,
  type: z.enum(MediaType).default("image"),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});

const codeSnippetSchema = z.object({
  language: z.string().trim().min(1).max(40),
  code: z.string().min(1, "A code post needs code").max(20_000),
});

/**
 * Poll creation. Options are 2-8: one option is not a poll, and the shipped
 * `PollVoter` renders a vertical list that stops being usable well before ten.
 */
const pollSchema = z.object({
  question: z.string().trim().min(1, "A poll needs a question").max(200),
  options: z
    .array(z.string().trim().min(1).max(80))
    .min(2, "A poll needs at least two options")
    .max(8, "A poll can have at most eight options")
    .refine(
      (options) => new Set(options.map((o) => o.toLowerCase())).size === options.length,
      { message: "Poll options must be distinct" },
    ),
  closesAt: z.coerce.date().nullable().optional(),
});

export const MAX_POST_LENGTH = 5_000;
export const MAX_MEDIA_ITEMS = 4;

/**
 * `POST /posts`.
 *
 * `content` may be empty only when the post carries something else — an image
 * post is a legitimate caption-less post, but a text post with no text is not.
 * That cross-field rule is enforced by refinement rather than by making
 * `content` required, because the shipped composer submits content for every
 * type it offers.
 */
export const createPostSchema = z
  .object({
    type: z.enum(PostType).default("text"),
    content: z
      .string()
      .trim()
      .max(MAX_POST_LENGTH, "Keep it under 5000 characters")
      .default(""),
    visibility: z.enum(Visibility).optional(),
    /** Optional attribution only — creating a post never touches the project. */
    projectId: z.string().uuid("Invalid project id").nullable().optional(),
    media: z.array(mediaItemSchema).max(MAX_MEDIA_ITEMS).optional(),
    /** The flat form the frontend's `Post.mediaUrls` uses, accepted as a convenience. */
    mediaUrls: z.array(mediaUrl).max(MAX_MEDIA_ITEMS).optional(),
    codeSnippet: codeSnippetSchema.optional(),
    poll: pollSchema.optional(),
  })
  .refine(
    (data) =>
      data.content.length > 0 ||
      (data.media?.length ?? 0) > 0 ||
      (data.mediaUrls?.length ?? 0) > 0 ||
      data.codeSnippet !== undefined ||
      data.poll !== undefined,
    { message: "A post needs content, media, code, or a poll", path: ["content"] },
  )
  .refine((data) => data.type !== "code" || data.codeSnippet !== undefined, {
    message: "A code post needs a codeSnippet",
    path: ["codeSnippet"],
  })
  .refine((data) => data.type !== "poll" || data.poll !== undefined, {
    message: "A poll post needs a poll",
    path: ["poll"],
  })
  .refine((data) => data.poll === undefined || data.type === "poll", {
    message: "Only a poll post may carry a poll",
    path: ["poll"],
  });

export type CreatePostInput = z.infer<typeof createPostSchema>;

/**
 * `PATCH /posts/:id`.
 *
 * `type` is absent: a text post must not become a poll after votes exist, and
 * changing type would invalidate the type-specific payload already stored.
 * `poll` is absent for the same reason — rewriting options after people have
 * voted would silently reassign their votes.
 */
export const updatePostSchema = z
  .object({
    content: z.string().trim().max(MAX_POST_LENGTH).optional(),
    visibility: z.enum(Visibility).optional(),
    media: z.array(mediaItemSchema).max(MAX_MEDIA_ITEMS).optional(),
    mediaUrls: z.array(mediaUrl).max(MAX_MEDIA_ITEMS).optional(),
    codeSnippet: codeSnippetSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdatePostInput = z.infer<typeof updatePostSchema>;

/* ── Comments ────────────────────────────────────────────────────────────── */

export const MAX_COMMENT_LENGTH = 2_000;

export const createCommentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "A comment needs some content")
    .max(MAX_COMMENT_LENGTH, "Keep it under 2000 characters"),
  /** Present for a reply. Depth beyond one level is refused by the service. */
  parentCommentId: z.string().uuid("Invalid comment id").nullable().optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "A comment needs some content")
    .max(MAX_COMMENT_LENGTH, "Keep it under 2000 characters"),
});
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

/* ── Polls ───────────────────────────────────────────────────────────────── */

/**
 * A vote names the **option**, not the poll — `PollVoter` receives the poll and
 * has only `option.id` in hand, and the frontend's `Poll` type carries no id at
 * all. The server derives the poll from the option.
 */
export const voteSchema = z.object({
  optionId: z.string().uuid("Invalid option id"),
});
export type VoteInput = z.infer<typeof voteSchema>;

/* ── Path parameters ─────────────────────────────────────────────────────── */

/** Posts have no slug; a malformed id is a 422 rather than a database trip. */
export const postIdParamSchema = z.object({
  id: z.string().uuid("Invalid post id"),
});
export type PostIdParam = z.infer<typeof postIdParamSchema>;

export const commentIdParamSchema = z.object({
  id: z.string().uuid("Invalid comment id"),
});
export type CommentIdParam = z.infer<typeof commentIdParamSchema>;

/* ── Feed, listing, pagination ───────────────────────────────────────────── */

/**
 * The six filters the shipped `FeedFilters` component renders.
 *
 * `ai_recommended` aliases `recommended` in this phase (decision J5):
 * ARCHITECTURE §11 forbids building a recommendation engine now, and returning
 * 501 would break a chip the UI already shows.
 */
export const FEED_FILTERS = [
  "latest",
  "trending",
  "following",
  "recommended",
  "popular_today",
  "ai_recommended",
] as const;
export type FeedFilterValue = (typeof FEED_FILTERS)[number];

export const feedQuerySchema = z.object({
  filter: z.enum(FEED_FILTERS).default("latest"),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/** `GET /feed/new-count?since=` — backs the shipped "new posts" pill. */
export const newCountQuerySchema = z.object({
  since: z.coerce.date(),
  filter: z.enum(FEED_FILTERS).default("latest"),
});
export type NewCountQuery = z.infer<typeof newCountQuerySchema>;

export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;
