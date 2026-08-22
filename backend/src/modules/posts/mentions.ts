/**
 * `@handle` mention parsing (PRD §8, §9 — decision J6).
 *
 * Pure and dependency-free. Mentions are parsed from content at write time and
 * announced through `NotificationPort`; **no `Mention` row is persisted**,
 * because the schema is frozen for this phase and has no such model. Phase 9
 * owns delivery and can persist whatever it needs from the port event.
 *
 * The handle charset mirrors `users.schema.usernameSchema` exactly — 3–30
 * characters of `[a-z0-9._]`. Parsing a wider set than the username rules allow
 * would produce candidates that can never resolve to an account.
 */

/** Matches the username charset, anchored so it cannot start mid-word. */
const MENTION_PATTERN = /(^|[^a-z0-9._@])@([a-z0-9._]{3,30})/gi;

/** A defensive ceiling: one post cannot notify an unbounded audience. */
export const MAX_MENTIONS_PER_POST = 10;

/**
 * Extracts unique, lowercased handles from post or comment content.
 *
 * Returns handles, not user ids — resolution against real accounts is the
 * service's job, and a handle that matches nothing is silently dropped there
 * rather than failing the write. Someone typing an email address or a
 * `user@example.com` string should not have their post rejected.
 *
 * Trailing dots and underscores are trimmed, so "ask @ava." mentions `ava`
 * rather than the unusable handle `ava.` — the username rules require at least
 * one alphanumeric but permit interior punctuation, and sentence-final
 * punctuation is far more likely than a handle that genuinely ends in a dot.
 */
export function parseMentions(content: string): string[] {
  const handles = new Set<string>();

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const raw = match[2];
    if (raw === undefined) continue;

    const handle = raw.toLowerCase().replace(/[._]+$/, "");

    // The username rules require at least one alphanumeric; a handle of only
    // dots and underscores is in-charset but can never name an account.
    if (handle.length < 3) continue;
    if (!/[a-z0-9]/.test(handle)) continue;

    handles.add(handle);
    if (handles.size >= MAX_MENTIONS_PER_POST) break;
  }

  return [...handles];
}
