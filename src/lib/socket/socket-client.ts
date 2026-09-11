import { io, type Socket } from "socket.io-client";

import { getAccessToken, refreshSession } from "@/lib/api";
import { SOCKET_URL } from "./config";

/**
 * The one Socket.IO connection.
 *
 * A module singleton, deliberately: the backend authenticates at the handshake
 * and joins the socket to a room per user, so a second connection is a second
 * room membership and a second copy of every event. Components subscribe to
 * this one instead of opening their own.
 *
 * This file is the *transport*. It knows nothing about conversations or
 * notifications — `SocketProvider` maps events onto React Query.
 */

let socket: Socket | null = null;

/**
 * Whether a refresh has already been tried for the current failure streak.
 *
 * Reset on every successful connect. Without it, a genuinely dead session
 * would loop: connect fails → refresh → reconnect → fails → refresh…
 */
let refreshAttempted = false;

export function getSocket(): Socket {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    // The provider decides when to connect — after auth resolves, never during
    // module evaluation, which on a signed-out visitor would be a guaranteed
    // failed handshake.
    autoConnect: false,
    withCredentials: true,
    // WebSocket from the first request, skipping Socket.IO's default HTTP
    // long-polling start. The backend runs on Vercel Functions, where each
    // HTTP request can land on a different instance: a polling session's
    // follow-up requests would reach instances that never saw its handshake.
    // A WebSocket is pinned to the instance that accepted it. Vercel's
    // docs list this setting as required for Socket.IO.
    transports: ["websocket"],
    // Socket.IO's own backoff. Reconnection is left on because a dropped
    // connection is normal (sleep, tunnel, flaky wifi) and re-running the
    // handshake is exactly the right recovery.
    reconnection: true,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,

    /**
     * **The token is read here, on every connection attempt.**
     *
     * The callback form matters. Passing `auth: { token }` would freeze
     * whatever token existed when the socket was constructed, and access
     * tokens expire — so the first reconnect after expiry would present a dead
     * token forever. This function runs again for every reconnect, so it
     * always sends whatever the token store holds *now*, including a value the
     * HTTP layer refreshed a moment ago.
     */
    auth: (cb: (data: Record<string, unknown>) => void) => {
      cb({ token: getAccessToken() ?? "" });
    },
  });

  socket.on("connect", () => {
    refreshAttempted = false;
  });

  /**
   * Handshake rejection.
   *
   * The backend tags an auth failure as `AUTHENTICATION_ERROR` in `err.data`,
   * which is what lets "your token expired, refresh and retry" be told apart
   * from "you are not signed in".
   *
   * The recovery reuses `refreshSession()` from the Phase 1 client rather than
   * refreshing here. That is the whole point: it is single-flight, so a socket
   * reconnect racing an HTTP 401 produces **one** `POST /auth/refresh` between
   * them, not two — and two would be worse than useless, since the backend
   * rotates the refresh token and the loser of the race would present a spent
   * one and force a logout.
   */
  socket.on("connect_error", (error: Error) => {
    const code = (error as Error & { data?: { code?: string } }).data?.code;
    if (code !== "AUTHENTICATION_ERROR" || refreshAttempted) return;

    refreshAttempted = true;
    void refreshSession().then((refreshed) => {
      // A null result means the session is genuinely over; `refreshSession`
      // has already cleared the token and notified the auth provider, which
      // disconnects this socket. Nothing to retry.
      if (refreshed) socket?.connect();
    });
  });

  return socket;
}

/** Opens the connection, if one is not already open. */
export function connectSocket(): Socket {
  const instance = getSocket();
  if (!instance.connected) instance.connect();
  return instance;
}

/**
 * Tears the connection down completely.
 *
 * Called on sign-out. `disconnect()` alone would leave the instance — and its
 * listeners — alive for the next user to inherit, so the singleton is dropped
 * too and the next sign-in builds a fresh one with a fresh token.
 */
export function disconnectSocket(): void {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  refreshAttempted = false;
}
