import { NotificationType } from "@prisma/client";
import { z } from "zod";

import { MAX_PAGE_SIZE } from "../../utils/pagination.js";

/**
 * Request validation for the notifications module (TRD §15).
 *
 * As in Phases 4–8, what these schemas *omit* carries the weight. There is no
 * `userId` anywhere — not in a body, not in a query, not in a path. The
 * recipient of every read and every mutation is the token holder, and because
 * no schema declares the field, a client that sends one is not rejected: Zod
 * strips it and the value never reaches a service. That is the same defence
 * the messaging module uses against a spoofed `senderId`, and the security
 * suite asserts it rather than trusting this paragraph.
 *
 * `type`, `actorId`, `entityType`, `entityId`, `message`, `isRead`, and
 * `readAt` are equally absent from every write schema. Notifications are
 * created by the server in response to events, never posted by a client —
 * there is deliberately no "create a notification" endpoint at all.
 */

const uuid = z.string().uuid("Must be a valid id");

export const notificationIdParamSchema = z.object({ id: uuid });

export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;

/**
 * The list query.
 *
 * Cursor pagination, per TRD §14's preference for high-volume and real-time
 * collections — a notification list is both.
 *
 * `unreadOnly` is the only filter. Filtering by type would be the beginning of
 * notification search, which the reconnaissance identified as a Phase 10
 * boundary; the badge and the panel are what this phase serves.
 */
export const notificationListQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(20),
  unreadOnly: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((value) => value === true || value === "true")
    .default(false),
});

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/**
 * Re-exported so the OpenAPI document and the preference lookups agree with
 * the schema's enum rather than a hand-maintained copy of it.
 */
export const NOTIFICATION_TYPES = Object.values(NotificationType);
