import type { Request, RequestHandler } from "express";

import { validated } from "../../middleware/validation.middleware.js";
import { successResponse } from "../../utils/response.js";
import { requireUser } from "../users/users.controller.js";
import {
  emitMessageDeleted,
  emitMessageNew,
  emitMessageRead,
} from "../../sockets/message.socket.js";
import * as service from "./messages.service.js";
import type {
  AddReactionInput,
  ConversationListQuery,
  ConversationParam,
  CreateConversationInput,
  EditMessageInput,
  MarkReadInput,
  MessageCursorQuery,
  MessageParam,
  MessageSearchQuery,
  ReactionParam,
  SendMessageInput,
} from "./messages.schema.js";

/**
 * HTTP adapter for the messaging module (BACKEND_ARCHITECTURE.md §4–5).
 *
 * Translates between HTTP and the services and nothing else. Every handler
 * passes `actorFrom(req)` — identity from the verified access token — so no
 * body, query, or path value can select who is sending, reading, or reacting.
 *
 * The REST write handlers also fan the result out over Socket.IO. That is
 * deliberate: a message sent from a client with no socket open must still
 * reach the recipient's open tab in real time, and the alternative — real-time
 * delivery only for socket senders — would make the feature depend on which
 * transport the sender happened to use. The emit always follows a successful
 * service call, never precedes it.
 */

export function actorFrom(req: Request): service.Actor {
  const user = requireUser(req);
  return { id: user.id, role: user.role };
}

function conversationIdFrom(res: Parameters<RequestHandler>[1]): string {
  return validated<ConversationParam>(res, "Params").conversationId;
}

function messageIdFrom(res: Parameters<RequestHandler>[1]): string {
  return validated<MessageParam>(res, "Params").messageId;
}

/* ── Conversations ───────────────────────────────────────────────────────── */

export const listConversations: RequestHandler = async (req, res) => {
  const page = await service.listConversations(
    actorFrom(req),
    validated<ConversationListQuery>(res, "Query"),
  );

  res.json(successResponse(page, "Conversations retrieved"));
};

/**
 * `POST /conversations` is idempotent by design.
 *
 * Reopening a chat you already have is the same request as starting one, and
 * the client should not have to know which it is. 201 when a row was created,
 * 200 when an existing conversation was returned — so a caller that cares can
 * tell, without either outcome being an error.
 */
export const createConversation: RequestHandler = async (req, res) => {
  const result = await service.startDirectConversation(
    actorFrom(req),
    (req.body as CreateConversationInput).username,
  );

  res
    .status(result.created ? 201 : 200)
    .json(
      successResponse(
        { conversation: result.conversation },
        result.created ? "Conversation created" : "Conversation retrieved",
      ),
    );
};

export const getConversation: RequestHandler = async (req, res) => {
  const conversation = await service.getConversation(
    conversationIdFrom(res),
    actorFrom(req),
  );

  res.json(successResponse({ conversation }, "Conversation retrieved"));
};

/* ── Messages ────────────────────────────────────────────────────────────── */

export const listMessages: RequestHandler = async (req, res) => {
  const page = await service.listMessages(
    conversationIdFrom(res),
    actorFrom(req),
    validated<MessageCursorQuery>(res, "Query"),
  );

  res.json(successResponse(page, "Messages retrieved"));
};

export const searchMessages: RequestHandler = async (req, res) => {
  const page = await service.searchMessages(
    conversationIdFrom(res),
    actorFrom(req),
    validated<MessageSearchQuery>(res, "Query"),
  );

  res.json(successResponse(page, "Messages retrieved"));
};

export const sendMessage: RequestHandler = async (req, res) => {
  const sent = await service.sendMessage(
    conversationIdFrom(res),
    actorFrom(req),
    req.body as SendMessageInput,
  );

  // Persisted before this line; recipients resolved from the database inside
  // the service, never from the request.
  emitMessageNew(sent);

  res.status(201).json(successResponse({ message: sent.message }, "Message sent"));
};

export const editMessage: RequestHandler = async (req, res) => {
  const message = await service.editMessage(
    messageIdFrom(res),
    actorFrom(req),
    (req.body as EditMessageInput).content,
  );

  res.json(successResponse({ message }, "Message updated"));
};

export const deleteMessage: RequestHandler = async (req, res) => {
  const result = await service.deleteMessage(messageIdFrom(res), actorFrom(req));

  emitMessageDeleted(result);

  res.json(
    successResponse(
      { id: result.id, conversationId: result.conversationId },
      "Message deleted",
    ),
  );
};

/* ── Reactions ───────────────────────────────────────────────────────────── */

/** Adding names the emoji in the body; removing names it in the path. */
export const addReaction: RequestHandler = async (req, res) => {
  const { emoji } = req.body as AddReactionInput;

  const message = await service.addReaction(messageIdFrom(res), actorFrom(req), emoji);

  res.status(201).json(successResponse({ message }, "Reaction added"));
};

export const removeReaction: RequestHandler = async (req, res) => {
  const { emoji } = validated<ReactionParam>(res, "Params");

  const message = await service.removeReaction(messageIdFrom(res), actorFrom(req), emoji);

  res.json(successResponse({ message }, "Reaction removed"));
};

/* ── Read state ──────────────────────────────────────────────────────────── */

export const markRead: RequestHandler = async (req, res) => {
  const actor = actorFrom(req);
  const conversationId = conversationIdFrom(res);

  const result = await service.markRead(
    conversationId,
    actor,
    (req.body as MarkReadInput).messageId,
  );

  emitMessageRead({ ...result, readerId: actor.id });

  res.json(successResponse(result.receipt, "Conversation marked as read"));
};

export const getUnreadCount: RequestHandler = async (req, res) => {
  const unread = await service.getUnreadCount(conversationIdFrom(res), actorFrom(req));

  res.json(successResponse(unread, "Unread count retrieved"));
};
