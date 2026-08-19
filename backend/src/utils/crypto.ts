import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { env } from "../config/env.js";

/**
 * Authenticated symmetric encryption for secrets that must be *readable* by
 * the server later — currently only TOTP shared secrets.
 *
 * Passwords and opaque tokens are hashed instead, because they only ever need
 * comparing. A TOTP secret is different: verifying a code requires the
 * original value, so it has to be reversible, which makes encryption at rest
 * the correct primitive rather than a digest.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const VERSION = "v1";

/**
 * Stretched once at import. A fixed salt is acceptable here because the input
 * is a high-entropy configuration secret (min 32 chars, enforced by the env
 * schema), not a user-chosen password — the KDF is for length normalization,
 * not for resisting a dictionary attack.
 */
const key = scryptSync(env.TWO_FACTOR_SECRET_KEY, "forgehub-2fa-kdf", 32);

/**
 * Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 *
 * The version prefix exists so a future key rotation or algorithm change can
 * decrypt old values instead of orphaning every enrolled authenticator.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Throws if the payload was tampered with — GCM's auth tag is verified on
 * `final()`, so a modified ciphertext cannot silently decrypt to garbage.
 */
export function decryptSecret(payload: string): string {
  const [version, ivPart, tagPart, dataPart] = payload.split(".");

  if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
    throw new Error("Malformed encrypted payload");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
