/**
 * Where a redirect is allowed to send someone.
 *
 * An OAuth flow leaves the site and comes back, so it has to carry the
 * user's intended destination across the round trip. That destination arrives
 * as a query parameter — attacker-controlled by construction — and handing it
 * to a `Location` header unchecked is the textbook open redirect: a link that
 * begins on a domain the user trusts and ends on one they do not, which is
 * how a convincing credential-phishing page gets its first click.
 *
 * So the destination is not "a URL that looks internal". It is a **path**,
 * reconstructed from the parts of the input that are safe to keep.
 */

/** Long enough for any real deep link, short enough not to be a payload. */
const MAX_LENGTH = 512;

/**
 * A base that cannot be reached, resolved against, or confused for real.
 *
 * `URL` needs a base to parse a relative reference. Using an unreachable
 * `.invalid` host (RFC 2606) means the origin comparison below is against a
 * value no input can legitimately produce.
 */
const SENTINEL_ORIGIN = "http://redirect-base.invalid";

/**
 * C0 controls and DEL. Written as a codepoint scan rather than a regex
 * literal, because the literal form of this test would put raw control
 * characters into the source file of the thing defending against them.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Returns the value as an internal path, or `null` if it is not one.
 *
 * The parse is the check. Anything with its own origin — `https://evil.example`,
 * the protocol-relative `//evil.example`, the backslash variants browsers
 * normalise into it — resolves to an origin that is not the sentinel and is
 * rejected. `javascript:` and `data:` fail the same test, because they parse
 * as absolute URLs with their own scheme.
 *
 * What survives is `pathname + search + hash` — reassembled from the parsed
 * URL rather than echoed from the input, so nothing that only *looked* like a
 * path can be smuggled through in the parts that are kept.
 */
export function safeInternalPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return null;
  // A destination is a path. Requiring the leading slash rejects
  // `evil.example` — which would otherwise resolve relative to the base and
  // come back looking like the path `/evil.example`.
  if (!trimmed.startsWith("/")) return null;
  // `//host` is protocol-relative and `/\host` is treated as such by browsers.
  // Both would parse to a foreign origin below; rejected here so the reason is
  // stated rather than inferred.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null;
  // A control character can split a header. Nothing legitimate contains one.
  if (hasControlCharacter(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, SENTINEL_ORIGIN);
  } catch {
    return null;
  }

  if (parsed.origin !== SENTINEL_ORIGIN) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
