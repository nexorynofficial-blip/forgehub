import { z } from "zod";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../utils/pagination.js";
import {
  MODERATION_ACTION_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from "./moderation.access.js";

/**
 * Request validation for the moderation module (TRD §15).
 *
 * As in Phases 4–10, what these schemas *omit* carries the weight. Zod strips
 * unknown keys, so a field that is not declared here cannot reach a service
 * however it is spelled or wherever it is placed. Four fields are deliberately
 * absent from every schema in this file:
 *
 *   - **`reporterId`** — the filer is the token holder.
 *   - **`reviewerId`** — the reviewer is the token holder.
 *   - **`moderatorId`** — the moderator is the token holder.
 *   - **`actorId`** — nothing here takes an actor from a client at all.
 *
 * `status` is absent from the report **create** body for the same reason: a
 * report is filed `pending` by the schema default, and a client cannot file
 * one pre-resolved. It appears only on the update body, where it is the point
 * of the request and is checked against the lifecycle state machine before it
 * is written.
 *
 * `tests/moderation-security.test.ts` asserts each of these by sending the
 * field and observing that it had no effect, rather than trusting this
 * paragraph.
 */

const uuid = z.string().uuid("Must be a valid id");

export const reportIdParamSchema = z.object({ id: uuid });
export type ReportIdParam = z.infer<typeof reportIdParamSchema>;

/* ── Report creation ─────────────────────────────────────────────────────── */

const MAX_DETAILS_LENGTH = 2000;

/**
 * The report body.
 *
 * `targetType` carries all six members including `message`, per PRD §17 and
 * the schema's own `ReportTargetType`. `details` is optional and defaults to
 * the empty string, matching `Report.details`'s own default — a report whose
 * reason is `spam` needs no essay.
 */
export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: uuid,
  reason: z.enum(REPORT_REASONS),
  details: z.string().max(MAX_DETAILS_LENGTH).trim().default(""),
});

export type CreateReportBody = z.infer<typeof createReportSchema>;

/* ── Queue listing ───────────────────────────────────────────────────────── */

/**
 * The queue query.
 *
 * Offset pagination, reusing `offsetPaginationSchema`'s own bounds rather than
 * redeclaring them — the moderation queue is a stable, page-numbered admin
 * table, which is exactly the case TRD §8 gives offset paging.
 *
 * `status` accepts all four members. The frontend's filter vocabulary has
 * three and omits `reviewing`; narrowing the backend to match would remove the
 * only state that lets a moderator claim a report, so the schema governs and
 * the frontend simply never sends the fourth value.
 */
export const listReportsQuerySchema = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;

/* ── Report review ───────────────────────────────────────────────────────── */

const MAX_RESOLUTION_LENGTH = 2000;

/**
 * The review body.
 *
 * Only `status` and an optional `resolution` note. `reviewerId` and
 * `resolvedAt` are server-owned: the reviewer is the caller, and the timestamp
 * is the moment the transition committed. A client that supplies either is
 * silently stripped.
 *
 * `pending` is accepted by the enum but refused by the state machine — no
 * transition leads back to it. Rejecting it here as well would produce a 422
 * where a 409 is more accurate, since the value is well-formed and merely
 * illegal from the report's current state.
 */
export const updateReportSchema = z.object({
  status: z.enum(REPORT_STATUSES),
  resolution: z.string().max(MAX_RESOLUTION_LENGTH).trim().optional(),
});

export type UpdateReportBody = z.infer<typeof updateReportSchema>;

/* ── Moderation actions ──────────────────────────────────────────────────── */

const MAX_REASON_LENGTH = 1000;

/**
 * The action body.
 *
 * `expiresAt` is an ISO timestamp and is checked two ways: the shape here, and
 * the semantic rule in `moderation.access.ts` that only a `suspension` may
 * carry one and every `suspension` must. Splitting it that way keeps the
 * "which verbs take an expiry" rule in the pure layer where the unit tests can
 * pin it, rather than encoding it as a Zod refinement the tests would have to
 * exercise through HTTP.
 *
 * `reportId` is optional: an action may be taken in response to a report, or
 * on a moderator's own initiative. When present it is verified to exist before
 * the action is recorded, so a caller cannot attach an action to a report id
 * they invented.
 */
export const createActionSchema = z.object({
  action: z.enum(MODERATION_ACTION_TYPES),
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: uuid,
  reason: z.string().max(MAX_REASON_LENGTH).trim().default(""),
  expiresAt: z.coerce.date().optional(),
  reportId: uuid.optional(),
});

export type CreateActionBody = z.infer<typeof createActionSchema>;
