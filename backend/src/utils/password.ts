import { hash, verify, type Options } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

/**
 * Password hashing (BACKEND_TRD.md §2, §12).
 *
 * Argon2id, chosen over bcrypt because the TRD prefers it and because
 * `@node-rs/argon2` ships prebuilt NAPI binaries. That matters concretely
 * here: both Dockerfile stages run `npm ci --ignore-scripts`, so a node-gyp
 * module (`argon2`, `bcrypt`) would never compile in the image.
 *
 * This module deliberately imports nothing from `config/` — it stays pure so
 * `prisma/seed.ts` can reuse it without booting the environment schema.
 */

/**
 * OWASP Password Storage Cheat Sheet's second recommended Argon2id profile
 * (19 MiB, t=2, p=1). Pinned explicitly rather than relying on library
 * defaults so a dependency upgrade cannot silently change the cost of every
 * hash in the database.
 */
/**
 * `Algorithm.Argon2id` is an ambient `const enum`, which `isolatedModules`
 * forbids referencing — hence the numeric literal behind its own named
 * constant rather than a bare `2` at the call site.
 */
const ARGON2ID = 2 as NonNullable<Options["algorithm"]>;

const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS);
}

/**
 * Constant-time-ish comparison against a stored digest.
 *
 * Returns `false` rather than throwing when the stored value is not a
 * parseable Argon2 hash. A malformed digest is a data problem, not a reason
 * to 500 — and treating it as "wrong password" is the safe direction.
 */
export async function verifyPassword(
  storedHash: string,
  plainPassword: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plainPassword, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * A real Argon2id digest of a value nobody knows.
 *
 * Login must cost the same whether or not the email exists, otherwise the
 * response time itself enumerates accounts: the "no such user" path would
 * skip the ~50ms hash that the "wrong password" path pays. Computed once at
 * import (not hardcoded) so it always uses the same parameters as live
 * hashes, which is what makes the timings actually match.
 */
const dummyHash: Promise<string> = hashPassword(randomBytes(32).toString("hex"));

/**
 * Burns the same work as a real password check, then fails.
 *
 * Call this on the unknown-email branch of login. Always resolves `false`.
 */
export async function verifyPasswordAgainstDummy(
  plainPassword: string,
): Promise<boolean> {
  return verifyPassword(await dummyHash, plainPassword);
}
