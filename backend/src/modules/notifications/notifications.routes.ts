import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./notifications.controller.js";
import {
  notificationIdParamSchema,
  notificationListQuerySchema,
} from "./notifications.schema.js";

/**
 * Notification endpoints, mounted at `/api/v1/notifications`
 * (ARCHITECTURE §11, TRD §5).
 *
 * `requireAuth` on **every** route, with no `optionalAuth` anywhere. A
 * notification list is a digest of everything one person has received; like
 * messaging and unlike projects, posts, or communities, it has no public face
 * and therefore no anonymous reader.
 *
 * A factory for consistency with the other feature routers, so any rate
 * limiter added later is constructed after `connectRedis()`.
 *
 * ## Route shape
 *
 * `/unread` and `/read-all` are literal segments declared **before**
 * `/:id/read`, the same ordering discipline `/communities/:slug/members` and
 * `/messages/conversations` needed. Belt and braces, `id` is uuid-validated,
 * so neither literal could be parsed as a notification id even if the order
 * were wrong.
 *
 * There is deliberately **no `POST /`** and no `DELETE`. Notifications are
 * server-generated, so a create endpoint would be a way to write text into
 * someone else's panel; and no specification, PRD line, or frontend affordance
 * asks for deletion — the panel offers "mark all as read" and nothing else.
 */
export function createNotificationRouter(): Router {
  const router = Router();

  router.get(
    "/",
    requireAuth,
    validate({ query: notificationListQuerySchema }),
    controller.list,
  );

  router.get("/unread", requireAuth, controller.getUnreadCount);

  router.post("/read-all", requireAuth, controller.markAllRead);

  router.post(
    "/:id/read",
    requireAuth,
    validate({ params: notificationIdParamSchema }),
    controller.markRead,
  );

  return router;
}
