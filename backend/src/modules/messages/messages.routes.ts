import { Router } from "express";

import { requireAuth } from "../../middleware/auth.middleware.js";
import { validate } from "../../middleware/validation.middleware.js";
import * as controller from "./messages.controller.js";
import {
  addReactionSchema,
  conversationListQuerySchema,
  conversationParamSchema,
  createConversationSchema,
  editMessageSchema,
  markReadSchema,
  messageCursorQuerySchema,
  messageParamSchema,
  messageSearchQuerySchema,
  reactionParamSchema,
  sendMessageSchema,
} from "./messages.schema.js";

/**
 * Messaging endpoints, mounted at `/api/v1/messages`
 * (BACKEND_ARCHITECTURE.md §11, §13).
 *
 * `requireAuth` on **every** route, with no `optionalAuth` anywhere. Unlike
 * projects, posts, and communities — all of which have a public face — private
 * correspondence has no anonymous reader, so there is no route here for one.
 *
 * A factory for consistency with the auth, user, project, post, and community
 * routers, so any rate limiter added later is constructed after
 * `connectRedis()`.
 *
 * ## Route shape
 *
 * `/conversations` and everything beneath it is declared **before**
 * `/:messageId`, the same ordering discipline `/communities/:slug/members`
 * needed: a literal segment must win against a parameter that could otherwise
 * swallow it. Belt and braces, `messageId` is uuid-validated, so
 * `/messages/conversations` could not be mistaken for a message id even if the
 * order were wrong.
 *
 * The per-message routes are `/messages/:messageId`, not
 * `/messages/messages/:messageId`. That stutter is what the established
 * convention rules out: Phase 6 addresses an individually-addressable child on
 * its own path (`/comments/:id`, not `/posts/comments/:id`), and ARCHITECTURE
 * §11 allocates `/api/v1/messages` as the base for this domain rather than for
 * the conversation sub-resource alone. Reported as a deviation from the
 * brief's example list, which anticipated exactly this case.
 */
export function createMessageRouter(): Router {
  const router = Router();

  /* ── Conversations ────────────────────────────────────────────────────── */

  router.get(
    "/conversations",
    requireAuth,
    validate({ query: conversationListQuerySchema }),
    controller.listConversations,
  );

  router.post(
    "/conversations",
    requireAuth,
    validate({ body: createConversationSchema }),
    controller.createConversation,
  );

  router.get(
    "/conversations/:conversationId",
    requireAuth,
    validate({ params: conversationParamSchema }),
    controller.getConversation,
  );

  /* ── Messages within a conversation ───────────────────────────────────── */

  /* `/messages/search` before `/messages`, and neither takes a message id —
     a thread's messages are addressed by cursor, not by position. */
  router.get(
    "/conversations/:conversationId/messages/search",
    requireAuth,
    validate({ params: conversationParamSchema, query: messageSearchQuerySchema }),
    controller.searchMessages,
  );

  router.get(
    "/conversations/:conversationId/messages",
    requireAuth,
    validate({ params: conversationParamSchema, query: messageCursorQuerySchema }),
    controller.listMessages,
  );

  router.post(
    "/conversations/:conversationId/messages",
    requireAuth,
    validate({ params: conversationParamSchema, body: sendMessageSchema }),
    controller.sendMessage,
  );

  /* ── Read state ───────────────────────────────────────────────────────── */

  router.post(
    "/conversations/:conversationId/read",
    requireAuth,
    validate({ params: conversationParamSchema, body: markReadSchema }),
    controller.markRead,
  );

  router.get(
    "/conversations/:conversationId/unread",
    requireAuth,
    validate({ params: conversationParamSchema }),
    controller.getUnreadCount,
  );

  /* ── A single message ─────────────────────────────────────────────────── */

  router.patch(
    "/:messageId",
    requireAuth,
    validate({ params: messageParamSchema, body: editMessageSchema }),
    controller.editMessage,
  );

  router.delete(
    "/:messageId",
    requireAuth,
    validate({ params: messageParamSchema }),
    controller.deleteMessage,
  );

  /* ── Reactions ────────────────────────────────────────────────────────── */

  router.post(
    "/:messageId/reactions",
    requireAuth,
    validate({ params: messageParamSchema, body: addReactionSchema }),
    controller.addReaction,
  );

  /* The emoji is a path segment and arrives percent-encoded; Express decodes
     it before validation, so the same bound applies as on the way in. */
  router.delete(
    "/:messageId/reactions/:emoji",
    requireAuth,
    validate({ params: reactionParamSchema }),
    controller.removeReaction,
  );

  return router;
}
