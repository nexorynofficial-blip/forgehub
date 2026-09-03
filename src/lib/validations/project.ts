import { z } from "zod";

/**
 * Creating a project.
 *
 * Mirrors the backend's `createProjectSchema` field for field, with the same
 * bounds and the same messages, so the form cannot pass locally and then be
 * rejected on submit. `title` is the only required field there, and it is the
 * only required field here.
 *
 * Three fields the API accepts are deliberately absent:
 *
 *  - **`tags`** — the backend resolves them against existing `Tag` rows and
 *    rejects anything unknown (decision J7). No endpoint lists the taxonomy,
 *    so a free-text field could only produce a 422 the user has no way to
 *    resolve. Offering it would be worse than omitting it.
 *  - **`coverImageUrl`, `gallery`** — there is no upload system, and these are
 *    free-form strings server-side rather than validated URLs. A URL box would
 *    be the only honest form of it, and `next/image` would reject any host
 *    outside the configured allowlist.
 *
 * Everything omitted here keeps the API's own default.
 */

/** Matches the backend's `optionalUrl`: an http(s) URL, or nothing at all. */
const optionalHttpUrl = z
  .union([
    z
      .string()
      .trim()
      .url("Enter a valid URL")
      .max(500)
      .refine(
        (value) => {
          const { protocol } = new URL(value);
          return protocol === "http:" || protocol === "https:";
        },
        { message: "Must be an http or https URL" },
      ),
    z.literal(""),
  ])
  .optional();

export const projectStatusValues = [
  "idea",
  "in_progress",
  "beta",
  "launched",
  "archived",
] as const;

export const fundingStageValues = [
  "bootstrapped",
  "pre_seed",
  "seed",
  "series_a_plus",
  "not_seeking",
] as const;

export const projectVisibilityValues = ["public", "private", "unlisted"] as const;

/**
 * Tech stack arrives from a single comma-separated input rather than a chip
 * editor, because no chip component exists in the design system and inventing
 * one is not this task. Split, trimmed, de-duplicated, and bounded exactly as
 * the API bounds it — 30 entries of at most 40 characters.
 */
export const techStackField = z
  .string()
  .trim()
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(
    z
      .array(z.string().max(40, "Each technology must be at most 40 characters"))
      .max(30, "At most 30 technologies"),
  )
  .transform((entries) => [...new Set(entries)]);

export const createProjectSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Must be at least 2 characters")
    .max(120, "Must be at most 120 characters"),
  description: z.string().trim().max(2000, "Keep it under 2000 characters").optional(),
  techStack: techStackField,
  status: z.enum(projectStatusValues),
  fundingStage: z.enum(fundingStageValues),
  visibility: z.enum(projectVisibilityValues),
  demoUrl: optionalHttpUrl,
  repositoryUrl: optionalHttpUrl,
  documentationUrl: optionalHttpUrl,
});

/** What the form holds *before* `techStack` is split — a plain string. */
export type CreateProjectFormValues = z.input<typeof createProjectSchema>;

/** What the resolver produces, and what the service posts. */
export type CreateProjectValues = z.output<typeof createProjectSchema>;
