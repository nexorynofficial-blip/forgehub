import type { ExtendedError, Socket } from "socket.io";

import { findActiveSessionWithUser } from "../modules/auth/auth.repository.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { logger } from "../utils/logger.js";

/**
 * Socket.IO handshake authentication (BACKEND_TRD.md §20).
 *
 * The rule §20 states plainly: *do not trust client-provided user IDs*. So
 * identity here comes from the same verified access token the REST API uses,
 * and is then re-read from the database — a `userId` in the handshake payload
 * is ignored entirely, because it is attacker-controlled.
 */

/** Identity carried on `socket.data` for the lifetime of the connection. */
export interface SocketUser {
  id: string;
  username: string;
  role: string;
  sessionId: string;
}

export interface SocketData {
  user: SocketUser;
}

export type AuthenticatedSocket = Socket<
  Record<string, never>,
  Record<string, never>,
  Record<string, never>,
  SocketData
>;

/** Room every authenticated socket joins, for user-targeted emits. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Reads the token from `socket.handshake.auth.token`, falling back to the
 * `Authorization` header for clients that cannot set handshake auth.
 */
function extractToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;

  if (typeof auth?.token === "string" && auth.token.length > 0) {
    return auth.token.replace(/^Bearer\s+/i, "");
  }

  const header = socket.handshake.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }

  return null;
}

function reject(message: string, code: string): ExtendedError {
  const error = new Error(message) as ExtendedError;
  // Surfaces on the client as `err.data.code`, so a UI can distinguish
  // "token expired, refresh and retry" from "not signed in".
  error.data = { code };
  return error;
}

/**
 * Connection-level gate. A socket that fails this never reaches any handler,
 * so downstream code can treat `socket.data.user` as always present.
 */
export async function authenticateSocket(
  socket: Socket,
  next: (err?: ExtendedError) => void,
): Promise<void> {
  const token = extractToken(socket);

  if (!token) {
    next(reject("Authentication required", "AUTHENTICATION_ERROR"));
    return;
  }

  try {
    const claims = await verifyAccessToken(token);
    const active = await findActiveSessionWithUser(claims.sid, claims.sub);

    if (!active) {
      next(reject("Session is no longer valid", "AUTHENTICATION_ERROR"));
      return;
    }

    if (active.user.status === "banned") {
      next(reject("This account has been suspended", "AUTHORIZATION_ERROR"));
      return;
    }

    (socket as AuthenticatedSocket).data.user = {
      id: active.user.id,
      username: active.user.username,
      role: active.user.role,
      sessionId: active.session.id,
    };

    next();
  } catch (error) {
    logger.debug({ err: error }, "Socket authentication rejected");
    next(reject("Invalid or expired token", "AUTHENTICATION_ERROR"));
  }
}
