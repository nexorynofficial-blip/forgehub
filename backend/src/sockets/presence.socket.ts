import { redis } from "../config/redis.js";
import * as messages from "../modules/messages/messages.service.js";
import { logger } from "../utils/logger.js";
import { userRoom, type AuthenticatedSocket } from "./auth.socket.js";
import { tryGetSocketServer } from "./socket.js";

/**
 * Presence (BACKEND_ARCHITECTURE.md §15, TRD §19).
 *
 * §15 is prescriptive: Redis holds short-lived presence, refreshed while
 * connected, expiring after disconnect — and *"do not rely on PostgreSQL for
 * high-frequency presence updates."* Nothing in this file writes to Postgres
 * except one bounded read to work out who cares.
 *
 * ## Why a set, not a flag
 *
 * The obvious implementation — `SET presence:user:{id} online` on connect,
 * `DEL` on disconnect — has a bug the brief calls out by name: *"do not mark a
 * user offline merely because one browser tab disconnected while another
 * active socket remains."* A single flag cannot tell one tab from three.
 *
 * So the key is a **set of socket ids**:
 *
 *   - connect    → `SADD` this socket id, then `EXPIRE` the key
 *   - disconnect → `SREM` this socket id; offline only when `SCARD` hits zero
 *   - heartbeat  → `EXPIRE` again for every locally connected user
 *
 * A counter would be simpler and wrong: a process that dies without running
 * its disconnect handlers leaves the count permanently inflated, and the user
 * shows online forever. Set members are idempotent — the same socket id added
 * twice is one member — and the TTL sweeps away anything a crash stranded,
 * which is exactly the resilience §15 asks for.
 *
 * ## Why the TTL is refreshed rather than set once
 *
 * The TTL is what makes stale presence self-correcting, so it has to be
 * shorter than "how long a ghost may linger" — but a key that expires while
 * the socket is still connected would report an active user as offline. The
 * heartbeat re-arms it at a fraction of its length, so a live connection keeps
 * the key indefinitely and a dead process stops refreshing and lets it lapse.
 */

/** Key holding the set of live socket ids for one user. */
export function presenceKey(userId: string): string {
  return `presence:user:${userId}`;
}

/**
 * Short, per §15. Long enough that a missed heartbeat does not flap a user
 * offline; short enough that a crashed process's ghosts clear within a minute.
 */
export const PRESENCE_TTL_SECONDS = 60;

/**
 * Comfortably under the TTL, so a single delayed tick cannot expire a live
 * key. Two refreshes fit inside every TTL window.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/** Locally connected users, for the heartbeat to refresh. Process-local. */
const localUsers = new Map<string, Set<string>>();

let heartbeat: NodeJS.Timeout | null = null;

/* ── Redis state ─────────────────────────────────────────────────────────── */

async function addPresence(userId: string, socketId: string): Promise<number> {
  const key = presenceKey(userId);
  // Pipelined: two round trips become one, and the EXPIRE cannot be skipped by
  // an error between the commands — a key without a TTL is a permanent ghost.
  const results = await redis
    .multi()
    .sadd(key, socketId)
    .expire(key, PRESENCE_TTL_SECONDS)
    .scard(key)
    .exec();

  const count = results?.[2]?.[1];
  return typeof count === "number" ? count : 1;
}

async function removePresence(userId: string, socketId: string): Promise<number> {
  const key = presenceKey(userId);
  const results = await redis.multi().srem(key, socketId).scard(key).exec();

  const count = results?.[1]?.[1];
  const remaining = typeof count === "number" ? count : 0;

  // Tidy rather than leaving an empty set to expire on its own; an empty key
  // and a missing key mean the same thing but only one of them costs memory.
  if (remaining === 0) await redis.del(key);

  return remaining;
}

/**
 * Whether a user has any live socket, according to Redis.
 *
 * Redis rather than the local socket server on purpose: with more than one
 * backend instance the local view is a fraction of the truth, and §14's
 * horizontal-scaling note means that is the expected deployment. This answer
 * stays correct when a second instance appears.
 */
export async function isOnline(userId: string): Promise<boolean> {
  const count = await redis.scard(presenceKey(userId));
  return count > 0;
}

/* ── Fan-out ─────────────────────────────────────────────────────────────── */

/**
 * Announces a presence transition to the people who share a conversation with
 * this user.
 *
 * Not a broadcast. Telling every connected socket when anyone comes online
 * would turn a chat feature into a live directory of who is at their desk, for
 * an audience that never asked and has no relationship to them. The audience
 * is resolved from conversation membership and bounded by the repository's
 * `take`.
 *
 * `presence:update` carries the same information as `user:online` /
 * `user:offline`; both are emitted because §14 and §19 each name a different
 * one and a client should not have to guess which this server speaks.
 */
async function announce(userId: string, online: boolean): Promise<void> {
  const io = tryGetSocketServer();
  if (!io) return;

  const audience = await messages.findPresenceAudience(userId);
  const payload = { userId, online, at: new Date().toISOString() };

  for (const memberId of audience) {
    io.to(userRoom(memberId)).emit(online ? "user:online" : "user:offline", payload);
    io.to(userRoom(memberId)).emit("presence:update", payload);
  }

  // The user's own other devices, so a second tab can render its own state.
  io.to(userRoom(userId)).emit("presence:update", payload);
}

/* ── Heartbeat ───────────────────────────────────────────────────────────── */

function startHeartbeat(): void {
  if (heartbeat) return;

  heartbeat = setInterval(() => {
    void (async () => {
      try {
        const pipeline = redis.multi();
        for (const userId of localUsers.keys()) {
          pipeline.expire(presenceKey(userId), PRESENCE_TTL_SECONDS);
        }
        await pipeline.exec();
      } catch (error) {
        // Presence is best-effort. A Redis blip must never take down the
        // socket layer or interrupt message delivery, which does not depend
        // on presence at all.
        logger.warn({ err: error }, "Presence heartbeat failed");
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);

  // Does not hold the process open: a server whose only remaining work is
  // refreshing presence TTLs should be allowed to exit.
  heartbeat.unref();
}

/**
 * Stops the heartbeat and forgets local state.
 *
 * Called from `closeSocketServer`, so a test suite that starts and stops a
 * server does not leave an interval behind — an un-cleared timer is the
 * classic reason a Vitest run hangs after its last assertion passes.
 */
export function stopPresenceTracking(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  localUsers.clear();
}

/* ── Registration ────────────────────────────────────────────────────────── */

/**
 * Marks a socket's user online and arranges for the disconnect transition.
 *
 * Both transitions are announced only on the *edge*: the first socket to
 * arrive announces online, the last to leave announces offline. A user with
 * three tabs generates one online event, not three, and refreshing a page
 * produces no offline event at all as long as the new socket connects before
 * the old one's `SREM` — and when it does not, the announcement is a
 * transition the audience can absorb.
 */
export function registerPresenceHandlers(socket: AuthenticatedSocket): void {
  const { user } = socket.data;

  const sockets = localUsers.get(user.id) ?? new Set<string>();
  sockets.add(socket.id);
  localUsers.set(user.id, sockets);

  startHeartbeat();

  void (async () => {
    try {
      const count = await addPresence(user.id, socket.id);
      if (count === 1) await announce(user.id, true);
    } catch (error) {
      logger.warn({ err: error, userId: user.id }, "Presence registration failed");
    }
  })();

  socket.on("disconnect", () => {
    const live = localUsers.get(user.id);
    if (live) {
      live.delete(socket.id);
      if (live.size === 0) localUsers.delete(user.id);
    }

    void (async () => {
      try {
        const remaining = await removePresence(user.id, socket.id);
        if (remaining === 0) await announce(user.id, false);
      } catch (error) {
        logger.warn({ err: error, userId: user.id }, "Presence cleanup failed");
      }
    })();
  });
}
