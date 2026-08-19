import { SignJWT } from "jose";
import { generate as generateTotpCode } from "otplib";
import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret } from "../src/utils/crypto.js";
import { signAccessToken, verifyAccessToken } from "../src/utils/jwt.js";
import {
  hashPassword,
  verifyPassword,
  verifyPasswordAgainstDummy,
} from "../src/utils/password.js";
import {
  BACKUP_CODE_COUNT,
  expiryFrom,
  generateBackupCode,
  generateBackupCodes,
  generateOpaqueToken,
  hashBackupCode,
  hashToken,
  normalizeBackupCode,
  parseDuration,
  safeCompareHashes,
} from "../src/utils/tokens.js";
import { generateTotpSecret, verifyTotp } from "../src/utils/totp.js";
import {
  pickAvailableUsername,
  randomUsername,
  sanitizeUsername,
  usernameBase,
} from "../src/utils/username.js";

/**
 * Unit coverage for the cryptographic primitives underneath authentication.
 *
 * Deliberately infrastructure-free: no Postgres, no Redis, no HTTP. These are
 * the pieces where a subtle mistake is invisible in an integration test —
 * a hash that always returns the same salt, or a verifier that accepts a
 * token signed with the wrong key, would still let a login flow "work".
 */

/** Matches the issuer/audience `signAccessToken` sets. */
const ISSUER = "forgehub";
const AUDIENCE = "forgehub-api";

const accessSecret = new TextEncoder().encode(process.env["JWT_ACCESS_SECRET"]);

describe("Password hashing", () => {
  it("round-trips a correct password", async () => {
    const digest = await hashPassword("CorrectHorse123");

    expect(digest.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(digest, "CorrectHorse123")).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const digest = await hashPassword("CorrectHorse123");

    await expect(verifyPassword(digest, "CorrectHorse124")).resolves.toBe(false);
    await expect(verifyPassword(digest, "")).resolves.toBe(false);
  });

  it("produces a different digest each time — salts must be unique", async () => {
    const [first, second] = await Promise.all([
      hashPassword("SamePassword123"),
      hashPassword("SamePassword123"),
    ]);

    // Identical digests would mean an unsalted (or fixed-salt) hash, which
    // makes the whole table rainbow-table-able at once.
    expect(first).not.toBe(second);
    await expect(verifyPassword(first, "SamePassword123")).resolves.toBe(true);
    await expect(verifyPassword(second, "SamePassword123")).resolves.toBe(true);
  });

  it("never stores the plaintext inside the digest", async () => {
    const digest = await hashPassword("Sup3rSecretValue");
    expect(digest).not.toContain("Sup3rSecretValue");
  });

  it("returns false rather than throwing on a malformed stored hash", async () => {
    // The pre-Phase-3 seed placeholder looked like this. It must fail closed.
    await expect(
      verifyPassword("$argon2id$v=19$m=65536,t=3,p=4$NOT_A_REAL_HASH", "anything"),
    ).resolves.toBe(false);
  });

  it("always fails the dummy verification used on the unknown-email path", async () => {
    await expect(verifyPasswordAgainstDummy("anything at all")).resolves.toBe(false);
  });
});

describe("Access tokens", () => {
  it("signs a token carrying subject, session, and role", async () => {
    const token = await signAccessToken({
      userId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      role: "member",
    });

    const claims = await verifyAccessToken(token);

    expect(claims.sub).toBe("11111111-1111-4111-8111-111111111111");
    expect(claims.sid).toBe("22222222-2222-4222-8222-222222222222");
    expect(claims.role).toBe("member");
    expect(claims.jti).toEqual(expect.any(String));
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ sid: "session", role: "member" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setJti("expired-token")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(accessSecret);

    await expect(verifyAccessToken(expired)).rejects.toThrow(/expired/i);
  });

  it("rejects a tampered payload", async () => {
    const token = await signAccessToken({
      userId: "user",
      sessionId: "session",
      role: "member",
    });

    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload as string, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    // Privilege escalation attempt: rewrite the role and keep the signature.
    decoded["role"] = "platform_admin";
    const forged = [
      header,
      Buffer.from(JSON.stringify(decoded)).toString("base64url"),
      signature,
    ].join(".");

    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const foreign = await new SignJWT({ sid: "session", role: "platform_admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti("foreign")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("a different secret at least 32 chars long"));

    await expect(verifyAccessToken(foreign)).rejects.toThrow();
  });

  it("rejects a token from another issuer or audience", async () => {
    const wrongIssuer = await new SignJWT({ sid: "session", role: "member" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user")
      .setIssuer("somebody-else")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setJti("wrong-issuer")
      .setExpirationTime("15m")
      .sign(accessSecret);

    await expect(verifyAccessToken(wrongIssuer)).rejects.toThrow();
  });

  it("rejects structurally valid tokens that are missing required claims", async () => {
    const incomplete = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(accessSecret);

    await expect(verifyAccessToken(incomplete)).rejects.toThrow();
  });

  it("rejects junk that is not a token at all", async () => {
    await expect(verifyAccessToken("not-a-token")).rejects.toThrow();
    await expect(verifyAccessToken("")).rejects.toThrow();
  });
});

describe("Opaque tokens", () => {
  it("generates unguessable, URL-safe values", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateOpaqueToken));

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      // 32 bytes base64url.
      expect(token.length).toBeGreaterThanOrEqual(43);
    }
  });

  it("hashes deterministically, so lookup by hash works", () => {
    const token = generateOpaqueToken();

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateOpaqueToken()));
  });

  it("never stores the token inside its hash", () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).not.toContain(token);
  });

  it("compares digests safely and rejects mismatched lengths", () => {
    const digest = hashToken("value");

    expect(safeCompareHashes(digest, digest)).toBe(true);
    expect(safeCompareHashes(digest, hashToken("other"))).toBe(false);
    expect(safeCompareHashes(digest, "ab")).toBe(false);
    expect(safeCompareHashes("", "")).toBe(false);
  });
});

describe("Backup codes", () => {
  it("issues ten distinct, readable codes", () => {
    const codes = generateBackupCodes();

    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      // Ambiguous glyphs are excluded so a code can be transcribed by hand.
      expect(code).not.toMatch(/[ILOU01]/);
    }
  });

  it("normalizes case and separators before hashing", () => {
    const code = generateBackupCode();
    const messy = ` ${code.toLowerCase().replace("-", " ")} `;

    expect(normalizeBackupCode(messy)).toBe(normalizeBackupCode(code));
    expect(hashBackupCode(messy)).toBe(hashBackupCode(code));
  });

  it("hashes to something that does not contain the code", () => {
    const code = generateBackupCode();
    expect(hashBackupCode(code)).not.toContain(normalizeBackupCode(code));
  });
});

describe("Duration parsing", () => {
  it("converts the shorthand the environment uses", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration("30d")).toBe(2_592_000_000);
  });

  it("rejects malformed durations instead of silently returning NaN", () => {
    expect(() => parseDuration("7 weeks")).toThrow();
    expect(() => parseDuration("d7")).toThrow();
    expect(() => parseDuration("")).toThrow();
  });

  it("produces an absolute expiry from a relative lifetime", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    expect(expiryFrom("1h", from).toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });
});

describe("Username generation", () => {
  it("folds a display name into the frontend's allowed character set", () => {
    // The rule the shipped account form enforces: /^[a-z0-9._]+$/i
    expect(sanitizeUsername("Ava Whitfield")).toBe("ava.whitfield");
    expect(sanitizeUsername("O'Brien-Smith")).toBe("o.brien.smith");
    expect(sanitizeUsername("  spaced   out  ")).toBe("spaced.out");
    expect(sanitizeUsername("Ava Whitfield")).toMatch(/^[a-z0-9._]+$/);
  });

  it("strips accents rather than dropping the letters", () => {
    expect(sanitizeUsername("Renée Ó Súilleabháin")).toBe("renee.o.suilleabhain");
  });

  it("pads a base that would be too short to be a valid username", () => {
    // Minimum length is 3; "Jo" alone would violate the frontend's own rule.
    expect(usernameBase("Jo").length).toBeGreaterThanOrEqual(3);
    expect(usernameBase("🎉🎉").length).toBeGreaterThanOrEqual(3);
    expect(usernameBase("Jo")).toMatch(/^[a-z0-9._]+$/);
    expect(usernameBase("🎉🎉")).toMatch(/^[a-z0-9._]+$/);
  });

  it("takes the base when it is free", () => {
    expect(pickAvailableUsername("ava.whitfield", [])).toBe("ava.whitfield");
  });

  it("resolves collisions with deterministic numeric suffixes", () => {
    expect(pickAvailableUsername("ava.whitfield", ["ava.whitfield"])).toBe(
      "ava.whitfield2",
    );
    expect(
      pickAvailableUsername("ava.whitfield", ["ava.whitfield", "ava.whitfield2"]),
    ).toBe("ava.whitfield3");
  });

  it("ignores case when deciding whether a handle is taken", () => {
    expect(pickAvailableUsername("ava.whitfield", ["AVA.WHITFIELD"])).toBe(
      "ava.whitfield2",
    );
  });

  it("falls back to a random suffix for the unique-constraint retry path", () => {
    const first = randomUsername("ava");
    const second = randomUsername("ava");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^ava\d{6}$/);
  });

  it("never exceeds the column's practical length", () => {
    const long = usernameBase("A".repeat(200));
    expect(pickAvailableUsername(long, [long]).length).toBeLessThanOrEqual(30);
    expect(randomUsername(long).length).toBeLessThanOrEqual(30);
  });
});

describe("Secret encryption", () => {
  it("round-trips a TOTP secret", () => {
    const secret = generateTotpSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("produces a different ciphertext each time — the nonce must be fresh", () => {
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("never leaves the plaintext visible in the stored payload", () => {
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toContain(secret);
  });

  it("refuses to decrypt a tampered payload", () => {
    const payload = encryptSecret("JBSWY3DPEHPK3PXP");
    const [version, iv, tag, data] = payload.split(".");
    const flipped = data === undefined ? "" : `A${data.slice(1)}`;

    expect(() => decryptSecret([version, iv, tag, flipped].join("."))).toThrow();
    expect(() => decryptSecret("garbage")).toThrow();
  });
});

describe("TOTP", () => {
  it("accepts the current code for a generated secret", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode({ secret });

    await expect(verifyTotp(secret, code)).resolves.toBe(true);
  });

  it("rejects a wrong code", async () => {
    const secret = generateTotpSecret();
    const code = await generateTotpCode({ secret });
    // Shift a digit so the value is well-formed but incorrect.
    const wrong = code === "000000" ? "111111" : "000000";

    await expect(verifyTotp(secret, wrong)).resolves.toBe(false);
  });

  it("rejects a code generated from a different secret", async () => {
    const [mine, theirs] = [generateTotpSecret(), generateTotpSecret()];
    const code = await generateTotpCode({ secret: theirs });

    await expect(verifyTotp(mine, code)).resolves.toBe(false);
  });

  it("returns false rather than throwing on malformed input", async () => {
    await expect(verifyTotp(generateTotpSecret(), "")).resolves.toBe(false);
    await expect(verifyTotp("not-base32!!", "123456")).resolves.toBe(false);
  });
});
