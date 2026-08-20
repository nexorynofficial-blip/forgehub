/**
 * OpenAPI 3.1 document (BACKEND_TRD.md §31).
 *
 * Hand-authored rather than generated: the schema components below are the
 * shared response envelope and error contract that every future endpoint
 * reuses via `$ref`, so feature modules only describe their own payloads.
 * Keeping it in sync with implementation is a per-phase requirement.
 */

import { env } from "./env.js";

/** Structural type — avoids depending on an OpenAPI types package. */
type OpenApiDocument = Record<string, unknown>;
type OpenApiObject = Record<string, unknown>;

const errorRef = { $ref: "#/components/schemas/ErrorEnvelope" };

/** Every endpoint answers with the same envelope, so responses are templated. */
function jsonResponse(description: string, schemaRef: OpenApiObject): OpenApiObject {
  return {
    description,
    content: { "application/json": { schema: schemaRef } },
  };
}

function errorResponses(...codes: readonly string[]): OpenApiObject {
  const descriptions: Record<string, string> = {
    "400": "Malformed request",
    "401": "Authentication failed or session no longer valid",
    "403": "Authenticated but not permitted",
    "404": "Resource not found",
    "409": "Conflicts with existing state",
    "422": "Request failed schema validation",
    "429": "Rate limited or temporarily locked out",
  };

  return Object.fromEntries(
    codes.map((code) => [code, jsonResponse(descriptions[code] ?? "Error", errorRef)]),
  );
}

function requestBody(schema: OpenApiObject, required = true): OpenApiObject {
  return { required, content: { "application/json": { schema } } };
}

/** Success payloads are `data` inside the shared envelope. */
function envelopeOf(data: OpenApiObject): OpenApiObject {
  return {
    allOf: [
      { $ref: "#/components/schemas/SuccessEnvelope" },
      { type: "object", properties: { data } },
    ],
  };
}

const stringField = (extra: OpenApiObject = {}): OpenApiObject => ({
  type: "string",
  ...extra,
});

/* ── Auth paths ─────────────────────────────────────────────────────────── */

const AUTH_TAG = "Authentication";
const SESSION_TAG = "Sessions";
const TWO_FACTOR_TAG = "Two-Factor";

const authPaths: OpenApiObject = {
  "/auth/register": {
    post: {
      tags: [AUTH_TAG],
      summary: "Create an account",
      description:
        "Responds identically whether or not the email is already registered — " +
        "a distinguishable response would make this endpoint an account-existence " +
        "oracle. The existing owner is emailed instead, and no second account is created.",
      requestBody: requestBody({
        type: "object",
        required: ["displayName", "email", "password", "confirmPassword", "agreeToTerms"],
        properties: {
          displayName: stringField({ minLength: 2, maxLength: 60 }),
          email: stringField({ format: "email" }),
          password: stringField({
            minLength: 8,
            description: "At least 8 characters, one uppercase letter, one number",
          }),
          confirmPassword: stringField(),
          agreeToTerms: { type: "boolean", const: true },
        },
      }),
      responses: {
        "201": jsonResponse(
          "Registration accepted; a verification email has been dispatched",
          envelopeOf({
            type: "object",
            properties: {
              email: stringField({ format: "email" }),
              verificationRequired: { type: "boolean" },
            },
          }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },

  "/auth/login": {
    post: {
      tags: [AUTH_TAG],
      summary: "Sign in with email and password",
      description:
        "On success the refresh token is set as an httpOnly cookie and is never " +
        "present in the response body. When the account has 2FA enabled, no tokens " +
        "are issued and a short-lived challenge is returned instead.",
      requestBody: requestBody({
        type: "object",
        required: ["email", "password"],
        properties: {
          email: stringField({ format: "email" }),
          password: stringField(),
          rememberMe: {
            type: "boolean",
            default: false,
            description: "Extends the refresh lifetime from 7 to 30 days",
          },
        },
      }),
      responses: {
        "200": {
          description: "Signed in, or a two-factor challenge was issued",
          headers: {
            "Set-Cookie": {
              description: `httpOnly refresh cookie (\`${env.REFRESH_COOKIE_NAME}\`)`,
              schema: { type: "string" },
            },
          },
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  envelopeOf({ $ref: "#/components/schemas/AuthSession" }),
                  envelopeOf({ $ref: "#/components/schemas/TwoFactorChallenge" }),
                ],
              },
            },
          },
        },
        ...errorResponses("401", "403", "422", "429"),
      },
    },
  },

  "/auth/refresh": {
    post: {
      tags: [AUTH_TAG],
      summary: "Rotate the refresh token and mint a new access token",
      description:
        "Reads the refresh cookie. The presented token is revoked and replaced. " +
        "Presenting an already-rotated token is treated as theft and revokes the " +
        "entire session.",
      security: [{ refreshCookie: [] }],
      responses: {
        "200": jsonResponse(
          "New access token issued and refresh cookie rotated",
          envelopeOf({ $ref: "#/components/schemas/AuthSession" }),
        ),
        ...errorResponses("401", "403"),
      },
    },
  },

  "/auth/logout": {
    post: {
      tags: [AUTH_TAG],
      summary: "Revoke the current session",
      description:
        "Intentionally succeeds even without a valid token — the caller's intent " +
        "is to end up signed out.",
      responses: {
        "200": jsonResponse(
          "Session revoked and cookies cleared",
          envelopeOf({
            type: "object",
            properties: { signedOut: { type: "boolean" } },
          }),
        ),
      },
    },
  },

  "/auth/me": {
    get: {
      tags: [AUTH_TAG],
      summary: "The authenticated user",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Current user",
          envelopeOf({
            type: "object",
            properties: { user: { $ref: "#/components/schemas/AuthUser" } },
          }),
        ),
        ...errorResponses("401", "403"),
      },
    },
  },

  "/auth/verify-email": {
    post: {
      tags: [AUTH_TAG],
      summary: "Consume an email-verification token",
      requestBody: requestBody({
        type: "object",
        required: ["token"],
        properties: { token: stringField() },
      }),
      responses: {
        "200": jsonResponse(
          "Email verified",
          envelopeOf({
            type: "object",
            properties: { user: { $ref: "#/components/schemas/AuthUser" } },
          }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },

  "/auth/verify-email/resend": {
    post: {
      tags: [AUTH_TAG],
      summary: "Re-send the verification email",
      description: "Always reports success, regardless of whether the address exists.",
      requestBody: requestBody({
        type: "object",
        required: ["email"],
        properties: { email: stringField({ format: "email" }) },
      }),
      responses: {
        "200": jsonResponse(
          "Request accepted",
          envelopeOf({ type: "object", properties: { sent: { type: "boolean" } } }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },

  "/auth/password/forgot": {
    post: {
      tags: [AUTH_TAG],
      summary: "Request a password-reset link",
      description: "Always reports success, regardless of whether the address exists.",
      requestBody: requestBody({
        type: "object",
        required: ["email"],
        properties: { email: stringField({ format: "email" }) },
      }),
      responses: {
        "200": jsonResponse(
          "Request accepted",
          envelopeOf({ type: "object", properties: { sent: { type: "boolean" } } }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },

  "/auth/password/reset": {
    post: {
      tags: [AUTH_TAG],
      summary: "Complete a password reset",
      description: "Single-use token. Every session for the account is revoked.",
      requestBody: requestBody({
        type: "object",
        required: ["token", "password", "confirmPassword"],
        properties: {
          token: stringField(),
          password: stringField({ minLength: 8 }),
          confirmPassword: stringField(),
        },
      }),
      responses: {
        "200": jsonResponse(
          "Password updated",
          envelopeOf({ type: "object", properties: { reset: { type: "boolean" } } }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },

  "/auth/password/change": {
    post: {
      tags: [AUTH_TAG],
      summary: "Change the password of the signed-in user",
      description: "Revokes every other session, keeping the caller's own.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["currentPassword", "newPassword", "confirmNewPassword"],
        properties: {
          currentPassword: stringField(),
          newPassword: stringField({ minLength: 8 }),
          confirmNewPassword: stringField(),
        },
      }),
      responses: {
        "200": jsonResponse(
          "Password changed",
          envelopeOf({ type: "object", properties: { changed: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/auth/sessions": {
    get: {
      tags: [SESSION_TAG],
      summary: "List active device sessions",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Active sessions",
          envelopeOf({
            type: "object",
            properties: {
              sessions: {
                type: "array",
                items: { $ref: "#/components/schemas/Session" },
              },
            },
          }),
        ),
        ...errorResponses("401"),
      },
    },
    delete: {
      tags: [SESSION_TAG],
      summary: "Revoke every session except the current one",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Number of sessions revoked",
          envelopeOf({
            type: "object",
            properties: { revoked: { type: "integer", minimum: 0 } },
          }),
        ),
        ...errorResponses("401"),
      },
    },
  },

  "/auth/sessions/{id}": {
    delete: {
      tags: [SESSION_TAG],
      summary: "Revoke one session",
      description:
        "Ownership is enforced server-side; a session belonging to another user " +
        "is reported as not found rather than forbidden, so ids cannot be probed.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": jsonResponse(
          "Session revoked",
          envelopeOf({ type: "object", properties: { revoked: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/auth/2fa/setup": {
    post: {
      tags: [TWO_FACTOR_TAG],
      summary: "Begin TOTP enrollment",
      description:
        "Returns the shared secret exactly once — it is stored encrypted and is " +
        "never readable again. 2FA is not active until /auth/2fa/confirm succeeds.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Enrollment material",
          envelopeOf({
            type: "object",
            properties: {
              secret: stringField({ description: "Base32, for manual entry" }),
              otpauthUrl: stringField({ description: "Render as a QR code" }),
            },
          }),
        ),
        ...errorResponses("401", "409"),
      },
    },
  },

  "/auth/2fa/confirm": {
    post: {
      tags: [TWO_FACTOR_TAG],
      summary: "Confirm enrollment and enable 2FA",
      description: "Returns single-use backup codes, shown once and never again.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["code"],
        properties: { code: stringField({ pattern: "^\\d{6}$" }) },
      }),
      responses: {
        "200": jsonResponse(
          "Two-factor authentication enabled",
          envelopeOf({
            type: "object",
            properties: {
              backupCodes: { type: "array", items: { type: "string" } },
            },
          }),
        ),
        ...errorResponses("401", "409", "422"),
      },
    },
  },

  "/auth/2fa/disable": {
    post: {
      tags: [TWO_FACTOR_TAG],
      summary: "Disable 2FA",
      description: "Requires the account password, not just a valid session.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["password"],
        properties: { password: stringField() },
      }),
      responses: {
        "200": jsonResponse(
          "Two-factor authentication disabled",
          envelopeOf({ type: "object", properties: { enabled: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/auth/2fa/challenge": {
    post: {
      tags: [TWO_FACTOR_TAG],
      summary: "Complete a login that stopped at the 2FA step",
      description:
        "Accepts either a 6-digit TOTP code or a single-use backup code. The " +
        "challenge token is read from the cookie set at login, or from the body.",
      requestBody: requestBody({
        type: "object",
        properties: {
          challengeToken: stringField({
            description: "Optional when the challenge cookie is present",
          }),
          code: stringField({ pattern: "^\\d{6}$" }),
          backupCode: stringField(),
        },
      }),
      responses: {
        "200": jsonResponse(
          "Signed in",
          envelopeOf({ $ref: "#/components/schemas/AuthSession" }),
        ),
        ...errorResponses("401", "403", "422", "429"),
      },
    },
  },
};

/* ── User & social-graph paths ──────────────────────────────────────────── */

const USERS_TAG = "Users";
const SOCIAL_TAG = "Social Graph";

const usernameParam = {
  name: "username",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-zA-Z0-9._]+$" },
} as const;

const cursorParams = [
  { name: "cursor", in: "query", required: false, schema: { type: "string" } },
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
] as const;

const userListResponse = envelopeOf({
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/UserPreview" } },
    nextCursor: { type: ["string", "null"] },
  },
});

const userPaths: OpenApiObject = {
  "/users/me": {
    get: {
      tags: [USERS_TAG],
      summary: "The authenticated user's own profile",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Current user, including owner-only fields",
          envelopeOf({
            type: "object",
            properties: { user: { $ref: "#/components/schemas/CurrentUser" } },
          }),
        ),
        ...errorResponses("401"),
      },
    },
    patch: {
      tags: [USERS_TAG],
      summary: "Update the caller's own profile",
      description:
        "Accepts the shipped Settings → Account payload. `socialLinks` is a " +
        "replace set, not a merge. `email` is accepted for form compatibility " +
        "but rejected with 422 if changed — email changes require verification.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        properties: {
          displayName: stringField({ minLength: 2, maxLength: 60 }),
          username: stringField({
            pattern: "^[a-zA-Z0-9._]+$",
            minLength: 3,
            maxLength: 30,
          }),
          email: stringField({ format: "email" }),
          bio: stringField({ maxLength: 280 }),
          location: { type: ["string", "null"], maxLength: 100 },
          websiteUrl: { type: ["string", "null"] },
          experienceYears: { type: ["integer", "null"], minimum: 0, maximum: 60 },
          skills: { type: "array", items: { type: "string" }, maxItems: 30 },
          techStack: { type: "array", items: { type: "string" }, maxItems: 30 },
          socialLinks: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              required: ["platform", "url"],
              properties: { platform: { type: "string" }, url: { type: "string" } },
            },
          },
        },
      }),
      responses: {
        "200": jsonResponse(
          "Updated profile",
          envelopeOf({
            type: "object",
            properties: { user: { $ref: "#/components/schemas/CurrentUser" } },
          }),
        ),
        ...errorResponses("401", "409", "422"),
      },
    },
  },

  "/users/me/username": {
    patch: {
      tags: [USERS_TAG],
      summary: "Change the caller's username",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["username"],
        properties: {
          username: stringField({
            pattern: "^[a-zA-Z0-9._]+$",
            minLength: 3,
            maxLength: 30,
          }),
        },
      }),
      responses: {
        "200": jsonResponse(
          "Username updated",
          envelopeOf({ type: "object", properties: { username: { type: "string" } } }),
        ),
        ...errorResponses("401", "409", "422"),
      },
    },
  },

  "/users/me/settings": {
    get: {
      tags: [USERS_TAG],
      summary: "Privacy settings",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Privacy settings",
          envelopeOf({
            type: "object",
            properties: { settings: { $ref: "#/components/schemas/PrivacySettings" } },
          }),
        ),
        ...errorResponses("401"),
      },
    },
    patch: {
      tags: [USERS_TAG],
      summary: "Update privacy settings",
      description:
        "`twoFactorEnabled` is readable here but not writable — enabling 2FA " +
        "requires the Phase 3 enrollment flow and a verified TOTP code.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        properties: {
          profileVisibility: { type: "string", enum: ["public", "followers"] },
          showEmailOnProfile: { type: "boolean" },
          whoCanMessage: { type: "string", enum: ["everyone", "followers"] },
        },
      }),
      responses: {
        "200": jsonResponse(
          "Updated settings",
          envelopeOf({
            type: "object",
            properties: { settings: { $ref: "#/components/schemas/PrivacySettings" } },
          }),
        ),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/users/me/notification-preferences": {
    get: {
      tags: [USERS_TAG],
      summary: "Notification preference matrix",
      description: "Always returns a complete matrix, one row per notification type.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Preference matrix",
          envelopeOf({
            type: "object",
            properties: {
              preferences: { $ref: "#/components/schemas/NotificationPreferences" },
            },
          }),
        ),
        ...errorResponses("401"),
      },
    },
    patch: {
      tags: [USERS_TAG],
      summary: "Update one notification preference",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          inApp: { type: "boolean" },
          email: { type: "boolean" },
        },
      }),
      responses: {
        "200": jsonResponse(
          "Updated matrix",
          envelopeOf({
            type: "object",
            properties: {
              preferences: { $ref: "#/components/schemas/NotificationPreferences" },
            },
          }),
        ),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/users/me/blocks": {
    get: {
      tags: [SOCIAL_TAG],
      summary: "Users the caller has blocked",
      security: [{ bearerAuth: [] }],
      parameters: [...cursorParams],
      responses: {
        "200": jsonResponse("Blocked users", userListResponse),
        ...errorResponses("401"),
      },
    },
  },

  "/users/{username}": {
    get: {
      tags: [USERS_TAG],
      summary: "Public profile by username",
      description:
        "Anonymous callers may read public profiles. A followers-only profile " +
        "returns a redacted identity shell to non-followers. If the target has " +
        "blocked the caller the response is 404, indistinguishable from a " +
        "non-existent account.",
      parameters: [usernameParam],
      responses: {
        "200": jsonResponse(
          "Profile, full or redacted",
          envelopeOf({
            type: "object",
            properties: {
              user: {
                oneOf: [
                  { $ref: "#/components/schemas/UserProfile" },
                  { $ref: "#/components/schemas/RedactedUserProfile" },
                ],
              },
              relationship: {
                oneOf: [{ $ref: "#/components/schemas/Relationship" }, { type: "null" }],
              },
            },
          }),
        ),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/users/{username}/achievements": {
    get: {
      tags: [USERS_TAG],
      summary: "Achievements and badges for a profile",
      description: "Read-only in this phase; the awarding engine is a later phase.",
      parameters: [usernameParam],
      responses: {
        "200": jsonResponse(
          "Achievements and badges",
          envelopeOf({
            type: "object",
            properties: {
              achievements: {
                type: "array",
                items: { $ref: "#/components/schemas/Achievement" },
              },
              badges: { type: "array", items: { $ref: "#/components/schemas/Badge" } },
            },
          }),
        ),
        ...errorResponses("403", "404", "422"),
      },
    },
  },

  "/users/{username}/followers": {
    get: {
      tags: [SOCIAL_TAG],
      summary: "Followers of a user",
      description:
        "Subject to the target's profile visibility — a followers-only profile " +
        "does not expose its follower list to non-followers.",
      parameters: [usernameParam, ...cursorParams],
      responses: {
        "200": jsonResponse("Followers", userListResponse),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/users/{username}/following": {
    get: {
      tags: [SOCIAL_TAG],
      summary: "Users a user follows",
      parameters: [usernameParam, ...cursorParams],
      responses: {
        "200": jsonResponse("Following", userListResponse),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/users/{username}/relationship": {
    get: {
      tags: [SOCIAL_TAG],
      summary: "Relationship between the caller and another user",
      security: [{ bearerAuth: [] }],
      parameters: [usernameParam],
      responses: {
        "200": jsonResponse(
          "Relationship state",
          envelopeOf({
            type: "object",
            properties: {
              relationship: { $ref: "#/components/schemas/Relationship" },
            },
          }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/users/{username}/follow": {
    post: {
      tags: [SOCIAL_TAG],
      summary: "Follow a user",
      description:
        "Not idempotent — following twice is a 409. Self-follow is rejected. " +
        "A block in either direction answers 404 rather than disclosing it.",
      security: [{ bearerAuth: [] }],
      parameters: [usernameParam],
      responses: {
        "201": jsonResponse(
          "Followed",
          envelopeOf({ $ref: "#/components/schemas/FollowResult" }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [SOCIAL_TAG],
      summary: "Unfollow a user",
      description: "Idempotent — unfollowing someone you do not follow succeeds.",
      security: [{ bearerAuth: [] }],
      parameters: [usernameParam],
      responses: {
        "200": jsonResponse(
          "Unfollowed",
          envelopeOf({ $ref: "#/components/schemas/FollowResult" }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/users/{username}/block": {
    post: {
      tags: [SOCIAL_TAG],
      summary: "Block a user",
      description:
        "Removes follows in BOTH directions and creates the block in one " +
        "transaction. Blocking an already-blocked user is a 409.",
      security: [{ bearerAuth: [] }],
      parameters: [usernameParam],
      responses: {
        "201": jsonResponse(
          "Blocked",
          envelopeOf({
            type: "object",
            properties: {
              blocking: { type: "boolean" },
              followsRemoved: { type: "integer", minimum: 0 },
            },
          }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [SOCIAL_TAG],
      summary: "Unblock a user",
      description: "Does NOT restore follows the block removed.",
      security: [{ bearerAuth: [] }],
      parameters: [usernameParam],
      responses: {
        "200": jsonResponse(
          "Unblocked",
          envelopeOf({
            type: "object",
            properties: {
              blocking: { type: "boolean" },
              followsRemoved: { type: "integer", minimum: 0 },
            },
          }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },
};

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "ForgeHub API",
    version: "1.0.0",
    description:
      "REST and realtime API for ForgeHub — a social platform for builders, " +
      "founders, designers, and developers.",
  },
  servers: [{ url: "/api/v1", description: "API v1" }],
  tags: [
    { name: "System", description: "Health, readiness, and version discovery" },
    { name: AUTH_TAG, description: "Registration, sign-in, tokens, and credentials" },
    { name: SESSION_TAG, description: "Device session management" },
    { name: TWO_FACTOR_TAG, description: "TOTP enrollment and login challenges" },
    { name: USERS_TAG, description: "Profiles, settings, and preferences" },
    { name: SOCIAL_TAG, description: "Follows, followers, and blocking" },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      /**
       * The refresh token is transported only as an httpOnly cookie, so it is
       * documented as its own scheme rather than as a body field.
       */
      refreshCookie: {
        type: "apiKey",
        in: "cookie",
        name: env.REFRESH_COOKIE_NAME,
      },
    },
    schemas: {
      SuccessEnvelope: {
        type: "object",
        required: ["success", "data", "message", "error"],
        properties: {
          success: { type: "boolean", const: true },
          data: { description: "Endpoint-specific payload" },
          message: { type: "string" },
          error: { type: "null" },
        },
      },
      Pagination: {
        type: "object",
        required: ["page", "limit", "total", "totalPages"],
        properties: {
          page: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
          total: { type: "integer", minimum: 0 },
          totalPages: { type: "integer", minimum: 0 },
        },
      },
      ErrorEnvelope: {
        type: "object",
        required: ["success", "data", "error"],
        properties: {
          success: { type: "boolean", const: false },
          data: { type: "null" },
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: {
                type: "string",
                enum: [
                  "VALIDATION_ERROR",
                  "AUTHENTICATION_ERROR",
                  "AUTHORIZATION_ERROR",
                  "NOT_FOUND",
                  "CONFLICT",
                  "RATE_LIMITED",
                  "DATABASE_ERROR",
                  "INTERNAL_ERROR",
                  "BAD_REQUEST",
                  "PAYLOAD_TOO_LARGE",
                  "SERVICE_UNAVAILABLE",
                ],
              },
              message: { type: "string" },
              details: {
                type: "array",
                items: {
                  type: "object",
                  required: ["field", "message"],
                  properties: {
                    field: { type: "string" },
                    message: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },

      /**
       * The user shape this phase serves. Reputation, counters, achievements,
       * and badges arrive with the users/profiles module in Phase 4.
       */
      AuthUser: {
        type: "object",
        required: [
          "id",
          "email",
          "username",
          "displayName",
          "role",
          "status",
          "emailVerified",
          "twoFactorEnabled",
          "createdAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          username: { type: "string" },
          displayName: { type: "string" },
          // Matches the frontend's `UserRole` union exactly.
          role: {
            type: "string",
            enum: [
              "guest",
              "member",
              "verified_builder",
              "moderator",
              "community_admin",
              "platform_admin",
            ],
          },
          status: { type: "string", enum: ["active", "banned", "shadow_banned"] },
          emailVerified: { type: "boolean" },
          twoFactorEnabled: { type: "boolean" },
          avatarUrl: { type: ["string", "null"] },
          bannerUrl: { type: ["string", "null"] },
          bio: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },

      AuthSession: {
        type: "object",
        required: ["user", "accessToken", "expiresIn"],
        properties: {
          user: { $ref: "#/components/schemas/AuthUser" },
          accessToken: {
            type: "string",
            description: "Short-lived JWT. Send as `Authorization: Bearer <token>`.",
          },
          expiresIn: {
            type: "integer",
            description: "Refresh cookie lifetime in milliseconds",
          },
        },
      },

      TwoFactorChallenge: {
        type: "object",
        required: ["twoFactorRequired", "challengeToken"],
        properties: {
          twoFactorRequired: { type: "boolean", const: true },
          challengeToken: {
            type: "string",
            description:
              "Also set as an httpOnly cookie; present here for non-browser clients.",
          },
        },
      },

      Achievement: {
        type: "object",
        required: ["id", "name", "description", "iconUrl", "unlockedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string" },
          iconUrl: { type: ["string", "null"] },
          unlockedAt: { type: ["string", "null"], format: "date-time" },
        },
      },

      Badge: {
        type: "object",
        required: ["id", "label", "iconUrl"],
        properties: {
          id: { type: "string", format: "uuid" },
          label: { type: "string" },
          iconUrl: { type: ["string", "null"] },
        },
      },

      /**
       * Mirrors the shipped frontend's `User` (`src/types/user.ts`) field for
       * field. `email` is null unless the viewer is the owner, an admin, or
       * the owner enabled `showEmailOnProfile`.
       */
      UserProfile: {
        type: "object",
        required: [
          "id",
          "username",
          "displayName",
          "email",
          "avatarUrl",
          "bannerUrl",
          "bio",
          "skills",
          "techStack",
          "socialLinks",
          "experienceYears",
          "achievements",
          "badges",
          "followersCount",
          "followingCount",
          "projectsCount",
          "role",
          "xp",
          "builderRank",
          "dailyStreak",
          "contributionScore",
          "communityScore",
          "createdAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
          email: { type: ["string", "null"], format: "email" },
          avatarUrl: { type: ["string", "null"] },
          bannerUrl: { type: ["string", "null"] },
          bio: { type: "string" },
          skills: { type: "array", items: { type: "string" } },
          techStack: { type: "array", items: { type: "string" } },
          socialLinks: {
            type: "array",
            items: {
              type: "object",
              required: ["platform", "url"],
              properties: { platform: { type: "string" }, url: { type: "string" } },
            },
          },
          experienceYears: { type: ["integer", "null"] },
          achievements: {
            type: "array",
            items: { $ref: "#/components/schemas/Achievement" },
          },
          badges: { type: "array", items: { $ref: "#/components/schemas/Badge" } },
          followersCount: { type: "integer", minimum: 0 },
          followingCount: { type: "integer", minimum: 0 },
          projectsCount: { type: "integer", minimum: 0 },
          role: {
            type: "string",
            enum: [
              "guest",
              "member",
              "verified_builder",
              "moderator",
              "community_admin",
              "platform_admin",
            ],
          },
          xp: { type: "integer" },
          builderRank: { type: "string" },
          dailyStreak: { type: "integer" },
          contributionScore: { type: "integer" },
          communityScore: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
        },
      },

      /** What a non-follower sees of a followers-only profile. Identity only. */
      RedactedUserProfile: {
        type: "object",
        required: ["id", "username", "displayName", "role", "builderRank", "restricted"],
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          bannerUrl: { type: ["string", "null"] },
          role: { type: "string" },
          builderRank: { type: "string" },
          followersCount: { type: "integer", minimum: 0 },
          followingCount: { type: "integer", minimum: 0 },
          projectsCount: { type: "integer", minimum: 0 },
          createdAt: { type: "string", format: "date-time" },
          restricted: { type: "boolean", const: true },
        },
      },

      CurrentUser: {
        allOf: [
          { $ref: "#/components/schemas/UserProfile" },
          {
            type: "object",
            required: ["emailVerified", "profileCompletion", "profileVisibility"],
            properties: {
              emailVerified: { type: "boolean" },
              profileCompletion: { type: "integer", minimum: 0, maximum: 100 },
              profileVisibility: { type: "string", enum: ["public", "followers"] },
            },
          },
        ],
      },

      /** Mirrors the frontend's `FollowerPreview` (`src/types/profile.ts`). */
      UserPreview: {
        type: "object",
        required: ["id", "username", "displayName", "avatarUrl"],
        properties: {
          id: { type: "string", format: "uuid" },
          username: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
        },
      },

      /**
       * Viewer-relative. There is deliberately no `isBlockedBy` — a profile
       * whose owner blocked the viewer resolves to 404 instead.
       */
      Relationship: {
        type: "object",
        required: ["isSelf", "isFollowing", "isFollowedBy", "isBlocking"],
        properties: {
          isSelf: { type: "boolean" },
          isFollowing: { type: "boolean" },
          isFollowedBy: { type: "boolean" },
          isBlocking: { type: "boolean" },
        },
      },

      FollowResult: {
        type: "object",
        required: ["following", "followersCount", "relationship"],
        properties: {
          following: { type: "boolean" },
          followersCount: { type: "integer", minimum: 0 },
          relationship: { $ref: "#/components/schemas/Relationship" },
        },
      },

      /** Mirrors the frontend's `PrivacySettings` (`src/types/settings.ts`). */
      PrivacySettings: {
        type: "object",
        required: [
          "profileVisibility",
          "showEmailOnProfile",
          "whoCanMessage",
          "twoFactorEnabled",
        ],
        properties: {
          profileVisibility: { type: "string", enum: ["public", "followers"] },
          showEmailOnProfile: { type: "boolean" },
          whoCanMessage: { type: "string", enum: ["everyone", "followers"] },
          twoFactorEnabled: {
            type: "boolean",
            description: "Read-only here; owned by the 2FA enrollment flow.",
          },
        },
      },

      /** `Record<NotificationType, { inApp, email }>`. */
      NotificationPreferences: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["inApp", "email"],
          properties: { inApp: { type: "boolean" }, email: { type: "boolean" } },
        },
      },

      Session: {
        type: "object",
        required: ["id", "createdAt", "lastUsedAt", "expiresAt", "current"],
        properties: {
          id: { type: "string", format: "uuid" },
          userAgent: { type: ["string", "null"] },
          ipAddress: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          current: { type: "boolean" },
        },
      },
    },
    responses: {
      ValidationError: {
        description: "Request failed schema validation",
        content: { "application/json": { schema: errorRef } },
      },
      NotFound: {
        description: "Resource not found",
        content: { "application/json": { schema: errorRef } },
      },
      RateLimited: {
        description: "Rate limit exceeded",
        content: { "application/json": { schema: errorRef } },
      },
    },
  },
  paths: {
    "/": {
      get: {
        tags: ["System"],
        summary: "API version discovery",
        responses: {
          "200": jsonResponse("API version information", {
            $ref: "#/components/schemas/SuccessEnvelope",
          }),
        },
      },
    },
    ...authPaths,
    ...userPaths,
  },
};

/**
 * Health probes live at the server root, outside the `/api/v1` server URL
 * above, so they are documented as a separate section rather than a path
 * that would incorrectly resolve to `/api/v1/health`.
 */
export const SYSTEM_ENDPOINTS = [
  { method: "GET", path: "/health", description: "Liveness — process is running" },
  {
    method: "GET",
    path: "/ready",
    description: "Readiness — PostgreSQL + Redis reachable",
  },
] as const;

/**
 * Socket.IO is not expressible in OpenAPI paths, so the realtime contract is
 * documented alongside it (TRD §31 asks for WebSocket events "where
 * practical"). Handshake auth lands in Phase 3; the message/presence events
 * arrive with their own phases.
 */
export const SOCKET_EVENTS = [
  {
    event: "connection",
    direction: "client → server",
    description:
      "Requires `auth.token` (or an Authorization header) carrying a valid access " +
      "token. Rejected connections emit `connect_error` with `data.code`.",
  },
  {
    event: "disconnect",
    direction: "server → client",
    description: "Standard Socket.IO lifecycle event.",
  },
] as const;
