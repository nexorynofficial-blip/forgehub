import type {
  EntityType,
  ModerationActionType,
  ReportReason,
  ReportStatus,
  ReportTargetType,
} from "@prisma/client";

/**
 * Response shapes for the moderation module (Phase 11).
 *
 * Every type here is what leaves the server, and `moderation.view.ts` is the
 * only file that builds one. Nothing on these interfaces is optional-by-
 * accident: a field that is sometimes absent is typed `| null` so a consumer
 * cannot mistake "not loaded" for "not set".
 */

/**
 * A person, as reports render them.
 *
 * Exactly the frontend's `PostAuthor` (`src/types/feed.ts`) — five fields, the
 * shape `ReportWithDetails.reporter` and `.targetAuthor` are already typed
 * against. `email`, `role`, and `status` are absent by construction: the
 * moderation queue is read by staff, but staff reading a queue still have no
 * need for a reporter's email address.
 */
export interface ModerationUserView {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  builderRank: string;
}

/**
 * One report.
 *
 * The flat fields match the frontend's `Report` interface exactly, so
 * `admin-service.ts` can drop its mock and keep its types. The three fields
 * below `status` are additions the schema carries and the mock omits —
 * `reviewerId`, `resolution`, `resolvedAt` — which the queue needs in order to
 * show who claimed a report and why it closed. A frontend that ignores them is
 * unaffected; one that wants them no longer has to guess.
 */
export interface ReportView {
  id: string;
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  targetAuthorId: string | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  reviewerId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * A report with its participants resolved.
 *
 * `targetSummary` is deliberately **not** included. The frontend computes it
 * client-side by looking the target up in its own caches
 * (`admin-service.resolveTargetSummary`), and reproducing it here would mean
 * the moderation queue joining five content tables on every page — and, worse,
 * projecting a snippet of a private project or a direct message into a
 * response. Staff open the target itself to see its content.
 */
export interface ReportDetailView extends ReportView {
  reporter: ModerationUserView | null;
  targetAuthor: ModerationUserView | null;
}

/** One recorded moderation action. */
export interface ModerationActionView {
  id: string;
  moderatorId: string | null;
  action: ModerationActionType;
  targetType: EntityType;
  targetId: string;
  targetUserId: string | null;
  reason: string;
  expiresAt: string | null;
  reportId: string | null;
  createdAt: string;
}

/**
 * What `POST /moderation/actions` returns.
 *
 * The action itself, plus the two things the caller cannot otherwise observe:
 * whether the target user's moderation status moved, and whether content was
 * actually removed. Both are reported rather than assumed — a content removal
 * whose target was already deleted is a successful, idempotent no-op, and the
 * caller should be able to tell.
 */
export interface ModerationActionResultView {
  action: ModerationActionView;
  statusChanged: boolean;
  contentRemoved: boolean;
}
