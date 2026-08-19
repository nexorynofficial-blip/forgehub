import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "../config/env.js";

/**
 * Opaque token generation and storage hashing (BACKEND_TRD.md §13).
 *
 * Refresh, email-verification, password-reset, and 2FA-challenge tokens are
 * all random values that the server never needs to read back — only compare.
 * So the database stores a hash, never the token itself: a dump of
 * `refresh_tokens` must not yield anything a client could present.
 */

/** 256 bits of entropy — far beyond guessable, and URL-safe. */
const TOKEN_BYTES = 32;

/**
 * The hash is keyed (HMAC) rather than a bare SHA-256.
 *
 * `JWT_REFRESH_SECRET` acts as a server-side pepper: an attacker holding only
 * a database dump cannot precompute or verify candidate tokens without also
 * having the application secret. This is what that env var is for — refresh
 * tokens themselves are opaque, not signed JWTs.
 */
const pepper = env.JWT_REFRESH_SECRET;

export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Deterministic: the same token always produces the same stored hash. */
export function hashToken(token: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

/** Compares two hex digests without leaking position of the first difference. */
export function safeCompareHashes(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/* ── Backup codes ───────────────────────────────────────────────────────── */

/**
 * Crockford-style base32 minus look-alikes (no I, L, O, U), so a code read
 * off a screen and typed back cannot be transcribed wrong.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_GROUP_LENGTH = 5;
const CODE_GROUPS = 2;
export const BACKUP_CODE_COUNT = 10;

/**
 * 10 characters from a 30-symbol alphabet ≈ 49 bits of entropy — high enough
 * that the stored digest can be a fast keyed hash rather than Argon2. That
 * matters: verifying a submitted code compares against every stored digest,
 * and ten Argon2 verifications per attempt would take ~500ms.
 */
function randomCodeGroup(): string {
  // 256 is not a multiple of 30, so masking alone would bias the low symbols.
  // Reject-sample instead: draw bytes until each falls in an unbiased range.
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let group = "";

  while (group.length < CODE_GROUP_LENGTH) {
    for (const byte of randomBytes(CODE_GROUP_LENGTH)) {
      if (byte >= limit) continue;
      group += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (group.length === CODE_GROUP_LENGTH) break;
    }
  }

  return group;
}

/** e.g. `A3KMP-7XQ2W`. Shown to the user exactly once, at enrollment. */
export function generateBackupCode(): string {
  return Array.from({ length: CODE_GROUPS }, randomCodeGroup).join("-");
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateBackupCode);
}

/** Normalizes user input: case and separator differences shouldn't matter. */
export function normalizeBackupCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Stored form. Normalized first so formatting never affects the digest. */
export function hashBackupCode(code: string): string {
  return hashToken(`backup:${normalizeBackupCode(code)}`);
}

/* ── Duration parsing ───────────────────────────────────────────────────── */

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Converts a JWT-style duration (`15m`, `7d`, `30d`) to milliseconds.
 *
 * Needed because a cookie's `maxAge` and a row's `expiresAt` are absolute
 * values, while the environment expresses lifetimes in the same shorthand
 * `jose` accepts for token expiry — one source of truth for both.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(value.trim());

  if (!match) {
    throw new Error(
      `Invalid duration "${value}" — expected a number followed by s, m, h, or d`,
    );
  }

  const amount = Number(match[1]);
  const unit = DURATION_UNITS[match[2] as string];

  if (unit === undefined) {
    throw new Error(`Invalid duration unit in "${value}"`);
  }

  return amount * unit;
}

/** Absolute expiry for a lifetime expressed as a duration string. */
export function expiryFrom(duration: string, from: Date = new Date()): Date {
  return new Date(from.getTime() + parseDuration(duration));
}
