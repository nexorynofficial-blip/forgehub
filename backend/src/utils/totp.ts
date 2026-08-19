import { generateSecret, generateURI, verify } from "otplib";

import { env } from "../config/env.js";

/**
 * TOTP primitives for two-factor authentication (BACKEND_PRD.md §4).
 *
 * Wraps `otplib` in a three-function surface so the rest of the codebase
 * never imports it directly — the same reasoning as the email and AI
 * abstractions in TRD §26/§27.
 */

/** 20 bytes / 160 bits — the RFC 4226 recommendation, and what authenticator apps expect. */
const SECRET_BYTES = 20;

/**
 * Accept codes one 30-second step either side of now. Without tolerance, a
 * user whose phone clock is a few seconds off can never log in; a wider
 * window would meaningfully extend how long a shoulder-surfed code stays
 * valid.
 */
const EPOCH_TOLERANCE_SECONDS = 30;

/** Base32, ready for manual entry into an authenticator app. */
export function generateTotpSecret(): string {
  return generateSecret({ length: SECRET_BYTES });
}

/**
 * `otpauth://totp/...` URI the frontend renders as a QR code.
 *
 * The label is the username rather than the email address: it is what the
 * authenticator app displays, and it should not put an account's email on
 * screen for anyone glancing at the phone.
 */
export function buildOtpauthUrl(secret: string, accountLabel: string): string {
  return generateURI({
    strategy: "totp",
    issuer: env.TOTP_ISSUER,
    label: accountLabel,
    secret,
  });
}

/** Constant-time inside otplib; returns false rather than throwing on junk. */
export async function verifyTotp(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({
      secret,
      token,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    });
    return result.valid;
  } catch {
    return false;
  }
}
