import { randomInt } from "node:crypto";

/**
 * Username derivation (Phase 3 decision J2).
 *
 * The shipped signup form collects displayName, email, and password — no
 * username — yet `users.username` is `NOT NULL UNIQUE` and profile routes are
 * `/profile/[username]`. So the server generates one.
 *
 * The character set and minimum length are taken from the frontend's own
 * account form (`src/lib/validations/settings.ts`: `/^[a-z0-9._]+$/i`, min 3),
 * so a generated handle is always something the user could have typed
 * themselves and can later edit without the field rejecting it.
 *
 * Derived from displayName only, never from the email address — an email
 * local part frequently contains a real name or an internal identifier the
 * user did not choose to publish.
 */

const MIN_LENGTH = 3;
const MAX_LENGTH = 30;
/** Leaves room for a collision suffix without exceeding MAX_LENGTH. */
const MAX_BASE_LENGTH = 24;

/**
 * Folds a display name into the allowed character set.
 *
 * Accented characters are decomposed and stripped rather than dropped whole,
 * so "Renée Ó Súilleabháin" yields "renee.o.suilleabhain" instead of
 * "n.silleabhin".
 */
export function sanitizeUsername(displayName: string): string {
  const folded = displayName
    .normalize("NFKD")
    // Combining marks left behind by the decomposition above.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Any run of disallowed characters becomes a single dot separator.
    .replace(/[^a-z0-9._]+/g, ".")
    .replace(/[._]{2,}/g, ".")
    .replace(/^[._]+|[._]+$/g, "");

  return folded.slice(0, MAX_BASE_LENGTH);
}

/**
 * A usable base, guaranteed to satisfy the length and charset rules.
 *
 * Falls back to a neutral `builder` prefix when the display name contains
 * nothing usable (e.g. it was entirely emoji or CJK punctuation).
 */
export function usernameBase(displayName: string): string {
  const sanitized = sanitizeUsername(displayName);

  if (sanitized.length >= MIN_LENGTH) return sanitized;

  // Pad rather than reject: registration must not fail because someone's
  // display name is two characters long.
  const padded = `${sanitized}${sanitized.length > 0 ? "." : ""}builder`;
  return padded.slice(0, MAX_BASE_LENGTH);
}

/**
 * Picks the lowest free numeric suffix for `base` given the handles already
 * taken. `ava.whitfield` → `ava.whitfield2` → `ava.whitfield3` …
 *
 * Deterministic, so the same inputs always give the same answer — which is
 * what makes the behavior testable. It is *not* by itself race-safe: two
 * simultaneous registrations can compute the same candidate. The unique index
 * is what actually prevents a duplicate, and the service retries on the
 * resulting conflict (see `nextUsernameCandidate`).
 */
export function pickAvailableUsername(base: string, taken: readonly string[]): string {
  const claimed = new Set(taken.map((name) => name.toLowerCase()));

  if (!claimed.has(base)) return base;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}${String(suffix)}`.slice(0, MAX_LENGTH);
    if (!claimed.has(candidate)) return candidate;
  }

  return randomUsername(base);
}

/**
 * Last-resort handle used when the deterministic sequence is exhausted or a
 * unique-constraint retry keeps losing the race. Random rather than
 * sequential precisely because the sequential candidate is what just failed.
 */
export function randomUsername(base: string): string {
  const suffix = String(randomInt(100_000, 1_000_000));
  const room = MAX_LENGTH - suffix.length;
  return `${base.slice(0, room)}${suffix}`;
}
