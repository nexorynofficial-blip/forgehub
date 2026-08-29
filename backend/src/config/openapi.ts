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

/* ── Project paths ──────────────────────────────────────────────────────── */

const PROJECTS_TAG = "Projects";
const PROJECT_TEAM_TAG = "Project Team";
const PROJECT_ROADMAP_TAG = "Project Roadmap";
const PROJECT_ENGAGEMENT_TAG = "Project Engagement";

/** Slug only — there is deliberately no UUID fallback (decision J2). */
const slugParam = {
  name: "slug",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-z0-9-]+$" },
} as const;

const childIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const offsetParams = [
  {
    name: "page",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, default: 1 },
  },
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
] as const;

/** Sort keys are whitelisted to indexed columns; see `projects.schema.ts`. */
const sortParam = {
  name: "sort",
  in: "query",
  required: false,
  schema: {
    type: "string",
    enum: ["recent", "trending", "progress", "updated"],
    default: "recent",
  },
} as const;

const projectRef = { $ref: "#/components/schemas/Project" };

const projectListResponse = {
  allOf: [
    { $ref: "#/components/schemas/SuccessEnvelope" },
    {
      type: "object",
      required: ["pagination"],
      properties: {
        data: { type: "array", items: projectRef },
        pagination: { $ref: "#/components/schemas/Pagination" },
      },
    },
  ],
};

const projectEnvelope = envelopeOf({
  type: "object",
  properties: { project: projectRef },
});

const metricsEnvelope = (extra: OpenApiObject): OpenApiObject =>
  envelopeOf({
    type: "object",
    properties: {
      ...extra,
      metrics: { $ref: "#/components/schemas/ProjectMetrics" },
    },
  });

const projectPaths: OpenApiObject = {
  "/projects": {
    get: {
      tags: [PROJECTS_TAG],
      summary: "Discover projects",
      description:
        "Public projects, plus the caller's own private and unlisted projects. " +
        "Unlisted projects are readable by slug but never enumerated here.",
      parameters: [
        ...offsetParams,
        sortParam,
        { name: "status", in: "query", required: false, schema: { type: "string" } },
        {
          name: "fundingStage",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        { name: "tag", in: "query", required: false, schema: { type: "string" } },
        { name: "tech", in: "query", required: false, schema: { type: "string" } },
      ],
      responses: {
        "200": jsonResponse("A page of projects", projectListResponse),
        ...errorResponses("422"),
      },
    },
    post: {
      tags: [PROJECTS_TAG],
      summary: "Create a project",
      description:
        "The slug is derived from the title server-side and cannot be supplied. " +
        "The caller becomes the owner and is created as an `owner` member in the " +
        "same transaction.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateProjectRequest" }),
      responses: {
        "201": jsonResponse("Project created", projectEnvelope),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/projects/trending": {
    get: {
      tags: [PROJECTS_TAG],
      summary: "Trending projects",
      description:
        "Public projects ordered by likes. Serves the dashboard widget's own " +
        "flat contract, not the full project shape.",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 5 },
        },
      ],
      responses: {
        "200": jsonResponse(
          "Trending projects",
          envelopeOf({
            type: "object",
            properties: {
              projects: {
                type: "array",
                items: { $ref: "#/components/schemas/TrendingProject" },
              },
            },
          }),
        ),
        ...errorResponses("422"),
      },
    },
  },

  "/projects/{slug}": {
    get: {
      tags: [PROJECTS_TAG],
      summary: "A single project",
      description:
        "404 — never 403 — when the project is private, soft-deleted, or owned " +
        "by someone who has blocked the caller.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "The project, plus the caller's relationship to it",
          envelopeOf({
            type: "object",
            properties: {
              project: projectRef,
              viewer: {
                oneOf: [
                  { $ref: "#/components/schemas/ProjectViewerState" },
                  { type: "null" },
                ],
              },
            },
          }),
        ),
        ...errorResponses("404", "422"),
      },
    },
    patch: {
      tags: [PROJECTS_TAG],
      summary: "Update a project",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/UpdateProjectRequest" }),
      responses: {
        "200": jsonResponse("Project updated", projectEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [PROJECTS_TAG],
      summary: "Soft-delete a project",
      description:
        "Sets `deletedAt` and decrements the owner's `projectsCount`. There is " +
        "no restore endpoint in this phase.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "Project deleted",
          envelopeOf({ type: "object", properties: { deleted: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/transfer": {
    post: {
      tags: [PROJECTS_TAG],
      summary: "Transfer ownership",
      description:
        "Owner of record only — not a project `admin`, and not a platform admin. " +
        "Moves `Project.ownerId`, both memberships, and both users' " +
        "`projectsCount` in one transaction.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        type: "object",
        required: ["username"],
        properties: { username: stringField() },
      }),
      responses: {
        "200": jsonResponse("Ownership transferred", projectEnvelope),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/projects/{slug}/members": {
    get: {
      tags: [PROJECT_TEAM_TAG],
      summary: "Project members",
      parameters: [slugParam, ...offsetParams],
      responses: {
        "200": jsonResponse("A page of members", {
          allOf: [
            { $ref: "#/components/schemas/SuccessEnvelope" },
            {
              type: "object",
              required: ["pagination"],
              properties: {
                data: {
                  type: "array",
                  items: { $ref: "#/components/schemas/ProjectMemberWithUser" },
                },
                pagination: { $ref: "#/components/schemas/Pagination" },
              },
            },
          ],
        }),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [PROJECT_TEAM_TAG],
      summary: "Add a member",
      description:
        "`role` accepts only `collaborator` and `contributor`. Assigning `owner` " +
        "is refused — use the transfer endpoint, which keeps both ownership " +
        "records in step.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        type: "object",
        required: ["username"],
        properties: {
          username: stringField(),
          role: {
            type: "string",
            enum: ["owner", "collaborator", "contributor"],
            default: "contributor",
          },
        },
      }),
      responses: {
        "201": jsonResponse(
          "Member added",
          envelopeOf({
            type: "object",
            properties: {
              member: { $ref: "#/components/schemas/ProjectMemberWithUser" },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/projects/{slug}/members/{username}": {
    patch: {
      tags: [PROJECT_TEAM_TAG],
      summary: "Change a member's role",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, usernameParam],
      requestBody: requestBody({
        type: "object",
        required: ["role"],
        properties: {
          role: { type: "string", enum: ["owner", "collaborator", "contributor"] },
        },
      }),
      responses: {
        "200": jsonResponse(
          "Role updated",
          envelopeOf({
            type: "object",
            properties: {
              member: { $ref: "#/components/schemas/ProjectMemberWithUser" },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [PROJECT_TEAM_TAG],
      summary: "Remove a member, or leave the project",
      description:
        "A member may always remove themselves; removing anyone else requires " +
        "team-management permission. The owner can do neither.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, usernameParam],
      responses: {
        "200": jsonResponse(
          "Member removed",
          envelopeOf({ type: "object", properties: { removed: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/milestones": {
    get: {
      tags: [PROJECT_ROADMAP_TAG],
      summary: "The project roadmap",
      description:
        "Unpaginated and ordered by `position` — the response sequence is the " +
        "render order.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "Milestones in roadmap order",
          envelopeOf({
            type: "object",
            properties: {
              milestones: {
                type: "array",
                items: { $ref: "#/components/schemas/Milestone" },
              },
            },
          }),
        ),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [PROJECT_ROADMAP_TAG],
      summary: "Add a milestone",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        type: "object",
        required: ["title"],
        properties: {
          title: stringField({ minLength: 2, maxLength: 120 }),
          description: stringField({ maxLength: 1000 }),
          isComplete: { type: "boolean" },
          targetDate: { type: ["string", "null"], format: "date-time" },
          position: { type: "integer", minimum: 0, maximum: 500 },
        },
      }),
      responses: {
        "201": jsonResponse(
          "Milestone created, with the recomputed project progress",
          envelopeOf({
            type: "object",
            properties: {
              milestone: { $ref: "#/components/schemas/Milestone" },
              progressPercent: { type: "integer", minimum: 0, maximum: 100 },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/milestones/{id}": {
    patch: {
      tags: [PROJECT_ROADMAP_TAG],
      summary: "Edit a milestone",
      description:
        "`completedAt` is maintained by the server when `isComplete` flips and " +
        "is not accepted from a client.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      requestBody: requestBody({
        type: "object",
        properties: {
          title: stringField({ minLength: 2, maxLength: 120 }),
          description: stringField({ maxLength: 1000 }),
          isComplete: { type: "boolean" },
          targetDate: { type: ["string", "null"], format: "date-time" },
          position: { type: "integer", minimum: 0, maximum: 500 },
        },
      }),
      responses: {
        "200": jsonResponse(
          "Milestone updated, with the recomputed project progress",
          envelopeOf({
            type: "object",
            properties: {
              milestone: { $ref: "#/components/schemas/Milestone" },
              progressPercent: { type: "integer", minimum: 0, maximum: 100 },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [PROJECT_ROADMAP_TAG],
      summary: "Remove a milestone",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      responses: {
        "200": jsonResponse(
          "Milestone deleted, with the recomputed project progress",
          envelopeOf({
            type: "object",
            properties: {
              deleted: { type: "boolean" },
              progressPercent: { type: "integer", minimum: 0, maximum: 100 },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/updates": {
    get: {
      tags: [PROJECTS_TAG],
      summary: "The project changelog",
      description:
        "Cursor-paginated, newest first. Distinct from the social feed: these " +
        "are the project's own record.",
      parameters: [slugParam, ...cursorParams],
      responses: {
        "200": jsonResponse(
          "A cursor page of updates",
          envelopeOf({
            type: "object",
            required: ["updates", "nextCursor"],
            properties: {
              updates: {
                type: "array",
                items: { $ref: "#/components/schemas/ProjectUpdate" },
              },
              nextCursor: { type: ["string", "null"] },
            },
          }),
        ),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [PROJECTS_TAG],
      summary: "Post an update",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        type: "object",
        required: ["content"],
        properties: { content: stringField({ minLength: 1, maxLength: 5000 }) },
      }),
      responses: {
        "201": jsonResponse(
          "Update posted",
          envelopeOf({
            type: "object",
            properties: { update: { $ref: "#/components/schemas/ProjectUpdate" } },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/updates/{id}": {
    patch: {
      tags: [PROJECTS_TAG],
      summary: "Edit an update",
      description: "The author may always edit their own; others need moderation rights.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      requestBody: requestBody({
        type: "object",
        required: ["content"],
        properties: { content: stringField({ minLength: 1, maxLength: 5000 }) },
      }),
      responses: {
        "200": jsonResponse(
          "Update edited",
          envelopeOf({
            type: "object",
            properties: { update: { $ref: "#/components/schemas/ProjectUpdate" } },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [PROJECTS_TAG],
      summary: "Soft-delete an update",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      responses: {
        "200": jsonResponse(
          "Update deleted",
          envelopeOf({ type: "object", properties: { deleted: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/projects/{slug}/like": {
    post: {
      tags: [PROJECT_ENGAGEMENT_TAG],
      summary: "Like a project",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "201": jsonResponse("Liked", metricsEnvelope({ liked: { type: "boolean" } })),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [PROJECT_ENGAGEMENT_TAG],
      summary: "Remove a like",
      description: "Idempotent — unliking something never liked is a success.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "200": jsonResponse("Unliked", metricsEnvelope({ liked: { type: "boolean" } })),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/projects/{slug}/follow": {
    post: {
      tags: [PROJECT_ENGAGEMENT_TAG],
      summary: "Follow a project",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "201": jsonResponse(
          "Following",
          metricsEnvelope({ following: { type: "boolean" } }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [PROJECT_ENGAGEMENT_TAG],
      summary: "Unfollow a project",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "Unfollowed",
          metricsEnvelope({ following: { type: "boolean" } }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/projects/{slug}/view": {
    post: {
      tags: [PROJECT_ENGAGEMENT_TAG],
      summary: "Record a view",
      description:
        "Deduplicated in Redis: at most one counted view per viewer — or per " +
        "source address when anonymous — per project per 24 hours. Owner views " +
        "are never counted. There is deliberately no unrestricted increment.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "View processed; `counted` reports whether it moved the counter",
          metricsEnvelope({ counted: { type: "boolean" } }),
        ),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/users/{username}/projects": {
    get: {
      tags: [PROJECTS_TAG],
      summary: "A profile's projects",
      description:
        "Also serves the shipped 'pinned projects' grid, which is the three " +
        "most-liked (`?sort=trending&limit=3`) — no persisted pin state exists.",
      parameters: [usernameParam, ...offsetParams, sortParam],
      responses: {
        "200": jsonResponse("A page of the owner's projects", projectListResponse),
        ...errorResponses("404", "422"),
      },
    },
  },
};

/* ── Post, comment, and feed paths ──────────────────────────────────────── */

const POSTS_TAG = "Posts";
const COMMENTS_TAG = "Comments";
const FEED_TAG = "Feed";

const postIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const postRef = { $ref: "#/components/schemas/Post" };

const postEnvelope = envelopeOf({
  type: "object",
  properties: {
    post: postRef,
    viewer: {
      oneOf: [{ $ref: "#/components/schemas/PostViewerState" }, { type: "null" }],
    },
  },
});

/** The frontend's `Paginated<T>` — items/nextCursor/total, not the offset block. */
const feedEnvelope = envelopeOf({
  type: "object",
  required: ["items", "nextCursor", "total"],
  properties: {
    items: { type: "array", items: postRef },
    nextCursor: { type: ["string", "null"] },
    total: { type: "integer", minimum: 0 },
  },
});

const commentPageEnvelope = envelopeOf({
  type: "object",
  required: ["comments", "nextCursor"],
  properties: {
    comments: { type: "array", items: { $ref: "#/components/schemas/Comment" } },
    nextCursor: { type: ["string", "null"] },
  },
});

const likeEnvelope = envelopeOf({
  type: "object",
  properties: {
    liked: { type: "boolean" },
    likesCount: { type: "integer", minimum: 0 },
  },
});

const postPaths: OpenApiObject = {
  "/posts": {
    post: {
      tags: [POSTS_TAG],
      summary: "Create a post",
      description:
        "The author is the authenticated caller. `communityId` is not accepted " +
        "in this phase, because community visibility depends on a Community " +
        "that a later phase owns.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({ $ref: "#/components/schemas/CreatePostRequest" }),
      responses: {
        "201": jsonResponse("Post created", postEnvelope),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/posts/{id}": {
    get: {
      tags: [POSTS_TAG],
      summary: "A single post",
      description:
        "404 — never 403 — when the post is private, soft-deleted, published " +
        "into a community, or authored by someone who has blocked the caller.",
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse(
          "The post, plus the caller's relationship to it",
          postEnvelope,
        ),
        ...errorResponses("404", "422"),
      },
    },
    patch: {
      tags: [POSTS_TAG],
      summary: "Edit a post",
      description:
        "Author only. An admin may remove a post but never rewrite it — " +
        "moderation removes content rather than restating it in another " +
        "person's voice. `type` and `poll` cannot change once votes may exist.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/UpdatePostRequest" }),
      responses: {
        "200": jsonResponse("Post updated", postEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [POSTS_TAG],
      summary: "Soft-delete a post",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse(
          "Post deleted",
          envelopeOf({ type: "object", properties: { deleted: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/posts/{id}/comments": {
    get: {
      tags: [COMMENTS_TAG],
      summary: "Top-level comments on a post",
      description:
        "Cursor-paginated, oldest first. A soft-deleted comment that still has " +
        "replies is returned as a tombstone so its replies stay reachable.",
      parameters: [postIdParam, ...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of comments", commentPageEnvelope),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [COMMENTS_TAG],
      summary: "Comment on a post, or reply to a comment",
      description:
        "Replies are one level deep. Replying to a reply is a 422 naming the " +
        "top-level comment to use instead.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateCommentRequest" }),
      responses: {
        "201": jsonResponse(
          "Comment posted",
          envelopeOf({
            type: "object",
            properties: { comment: { $ref: "#/components/schemas/Comment" } },
          }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/posts/{id}/like": {
    post: {
      tags: [POSTS_TAG],
      summary: "Like a post",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "201": jsonResponse("Liked", likeEnvelope),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [POSTS_TAG],
      summary: "Remove a like",
      description: "Idempotent — unliking something never liked is a success.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse("Unliked", likeEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/posts/{id}/bookmark": {
    post: {
      tags: [POSTS_TAG],
      summary: "Bookmark a post",
      description:
        "Bookmarks are private and carry no counter — there is no public " +
        "tally, so saving something is never a signal to anyone else.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "201": jsonResponse(
          "Bookmarked",
          envelopeOf({ type: "object", properties: { bookmarked: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [POSTS_TAG],
      summary: "Remove a bookmark",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse(
          "Bookmark removed",
          envelopeOf({ type: "object", properties: { bookmarked: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/posts/{id}/poll/vote": {
    post: {
      tags: [POSTS_TAG],
      summary: "Vote in a post's poll",
      description:
        "The request names an **option**, not the poll: the frontend's `Poll` " +
        "type carries no id. Votes are final — the unique constraint is on the " +
        "poll, so a second vote for any option is a 409.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      requestBody: requestBody({
        type: "object",
        required: ["optionId"],
        properties: { optionId: stringField({ format: "uuid" }) },
      }),
      responses: {
        "201": jsonResponse(
          "Vote recorded, with the updated tallies",
          envelopeOf({
            type: "object",
            properties: {
              votedOptionId: stringField({ format: "uuid" }),
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: stringField({ format: "uuid" }),
                    voteCount: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
  },

  "/comments/{id}": {
    patch: {
      tags: [COMMENTS_TAG],
      summary: "Edit a comment",
      description: "Author only — not the post author, and not an admin.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      requestBody: requestBody({
        type: "object",
        required: ["content"],
        properties: { content: stringField({ minLength: 1, maxLength: 2000 }) },
      }),
      responses: {
        "200": jsonResponse(
          "Comment updated",
          envelopeOf({
            type: "object",
            properties: { comment: { $ref: "#/components/schemas/Comment" } },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [COMMENTS_TAG],
      summary: "Soft-delete a comment",
      description:
        "Permitted to the comment's author, the post's author (thread " +
        "moderation), and platform admins. A deleted comment with replies " +
        "survives as a tombstone.",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse(
          "Comment deleted",
          envelopeOf({ type: "object", properties: { deleted: { type: "boolean" } } }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/comments/{id}/replies": {
    get: {
      tags: [COMMENTS_TAG],
      summary: "Replies to a comment",
      description: "One level deep; a reply can never itself have replies.",
      parameters: [postIdParam, ...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of replies", commentPageEnvelope),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/comments/{id}/like": {
    post: {
      tags: [COMMENTS_TAG],
      summary: "Like a comment",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "201": jsonResponse("Liked", likeEnvelope),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
    delete: {
      tags: [COMMENTS_TAG],
      summary: "Remove a comment like",
      security: [{ bearerAuth: [] }],
      parameters: [postIdParam],
      responses: {
        "200": jsonResponse("Unliked", likeEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/feed": {
    get: {
      tags: [FEED_TAG],
      summary: "The social feed",
      description:
        "Cursor-paginated. Every filter is a database query over an indexed " +
        "column — there is no recommendation engine in this phase, so " +
        "`ai_recommended` aliases `recommended` rather than failing a filter " +
        "the shipped UI already offers.",
      parameters: [
        {
          name: "filter",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: [
              "latest",
              "trending",
              "following",
              "recommended",
              "popular_today",
              "ai_recommended",
            ],
            default: "latest",
          },
        },
        ...cursorParams,
      ],
      responses: {
        "200": jsonResponse("A cursor page of posts", feedEnvelope),
        ...errorResponses("422"),
      },
    },
  },

  "/feed/new-count": {
    get: {
      tags: [FEED_TAG],
      summary: "How many posts are newer than a watermark",
      description:
        "Counted against the same visibility scope the feed serves, so it " +
        "never promises rows the feed would then refuse to return.",
      parameters: [
        {
          name: "since",
          in: "query",
          required: true,
          schema: { type: "string", format: "date-time" },
        },
        {
          name: "filter",
          in: "query",
          required: false,
          schema: { type: "string", default: "latest" },
        },
      ],
      responses: {
        "200": jsonResponse(
          "The count",
          envelopeOf({
            type: "object",
            properties: {
              count: { type: "integer", minimum: 0 },
              since: stringField({ format: "date-time" }),
            },
          }),
        ),
        ...errorResponses("422"),
      },
    },
  },

  "/users/{username}/posts": {
    get: {
      tags: [POSTS_TAG],
      summary: "A profile's posts",
      parameters: [usernameParam, ...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of the author's posts", feedEnvelope),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/users/me/bookmarks": {
    get: {
      tags: [POSTS_TAG],
      summary: "The caller's own bookmarks",
      description: "Never exposed for another user.",
      security: [{ bearerAuth: [] }],
      parameters: [...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of bookmarked posts", feedEnvelope),
        ...errorResponses("401", "422"),
      },
    },
  },
};

export /* ── Communities (Phase 7) ───────────────────────────────────────────────── */

const COMMUNITIES_TAG = "Communities";
const COMMUNITY_MEMBERS_TAG = "Community Members";
const COMMUNITY_RESOURCES_TAG = "Community Resources";
const COMMUNITY_POSTS_TAG = "Community Posts";

const communityRef = { $ref: "#/components/schemas/Community" };
const communityMemberRef = { $ref: "#/components/schemas/CommunityMemberWithUser" };

const communityEnvelope = envelopeOf({
  type: "object",
  properties: {
    community: communityRef,
    viewer: {
      oneOf: [{ $ref: "#/components/schemas/CommunityViewerState" }, { type: "null" }],
    },
  },
});

/** Writes return the community alone; the caller's own state is unchanged. */
const communityOnlyEnvelope = envelopeOf({
  type: "object",
  required: ["community"],
  properties: { community: communityRef },
});

const communityPageEnvelope = envelopeOf({
  type: "object",
  required: ["items", "nextCursor", "total"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/CommunitySummary" } },
    nextCursor: { type: ["string", "null"] },
    total: {
      type: "null",
      description:
        "Always null: a COUNT over the visibility-filtered set costs a second " +
        "full scan and no shipped surface renders a community total.",
    },
  },
});

const memberPageEnvelope = envelopeOf({
  type: "object",
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: communityMemberRef },
    nextCursor: {
      type: ["string", "null"],
      description: "A `userId` — the roster cursors on the (community, user) unique.",
    },
  },
});

const moderatorsEnvelope = envelopeOf({
  type: "object",
  required: ["moderators"],
  properties: { moderators: { type: "array", items: communityMemberRef } },
});

const memberEnvelope = envelopeOf({
  type: "object",
  required: ["member"],
  properties: { member: communityMemberRef },
});

const eventEnvelope = envelopeOf({
  type: "object",
  required: ["event"],
  properties: { event: { $ref: "#/components/schemas/CommunityEventDetail" } },
});

const eventListEnvelope = envelopeOf({
  type: "object",
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: { $ref: "#/components/schemas/CommunityEventDetail" },
    },
  },
});

const pinsEnvelope = envelopeOf({
  type: "object",
  required: ["pinnedPostIds"],
  properties: {
    pinnedPostIds: { type: "array", items: { type: "string", format: "uuid" } },
  },
});

const communitySortParam = {
  name: "sort",
  in: "query",
  required: false,
  schema: { type: "string", enum: ["recent", "members"], default: "recent" },
} as const;

const communityPaths: OpenApiObject = {
  "/communities": {
    get: {
      tags: [COMMUNITIES_TAG],
      summary: "Discover communities",
      description:
        "Cursor-paginated. Public communities are visible to everyone; unlisted " +
        "ones are readable by slug but never enumerated here, and private ones " +
        "appear only for their owner, members, and platform admins. A community " +
        "whose owner has blocked the caller is omitted entirely.",
      parameters: [
        ...cursorParams,
        communitySortParam,
        {
          name: "category",
          in: "query",
          required: false,
          schema: { type: "string", maxLength: 60 },
        },
        {
          name: "q",
          in: "query",
          required: false,
          description: "Case-insensitive search across name and description.",
          schema: { type: "string", minLength: 1, maxLength: 100 },
        },
      ],
      responses: {
        "200": jsonResponse("A cursor page of communities", communityPageEnvelope),
        ...errorResponses("422"),
      },
    },
    post: {
      tags: [COMMUNITIES_TAG],
      summary: "Create a community",
      description:
        "The owner is the authenticated caller, and their `owner` membership row " +
        "is created in the same transaction — `memberCount` starts at 1. The slug " +
        "is derived from the name server-side and cannot be chosen or later changed.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        $ref: "#/components/schemas/CreateCommunityRequest",
      }),
      responses: {
        "201": jsonResponse("Community created", communityOnlyEnvelope),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/communities/{slug}": {
    get: {
      tags: [COMMUNITIES_TAG],
      summary: "A single community",
      description:
        "404 — never 403 — when the community is private to the caller, " +
        "soft-deleted, or owned by someone who has blocked them. `viewer` is null " +
        "for anonymous callers.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "The community, plus the caller's relationship to it",
          communityEnvelope,
        ),
        ...errorResponses("404", "422"),
      },
    },
    patch: {
      tags: [COMMUNITIES_TAG],
      summary: "Update a community",
      description: "Requires `edit_community` — owner or admin. The slug is immutable.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        $ref: "#/components/schemas/UpdateCommunityRequest",
      }),
      responses: {
        "200": jsonResponse("Community updated", communityOnlyEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [COMMUNITIES_TAG],
      summary: "Soft-delete a community",
      description:
        "Owner or platform admin. Soft delete with no restore: the community and " +
        "every post inside it become unreadable, and its tags are released so the " +
        "shared `Tag.usageCount` does not stay inflated.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "Community deleted",
          envelopeOf({
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              deleted: { type: "boolean", const: true },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/members": {
    get: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "The member roster",
      parameters: [slugParam, ...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of members", memberPageEnvelope),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Add a member directly",
      description:
        "Requires `manage_members` — owner or admin. The only route into a private " +
        "community, since there is no invitation model. Granting `admin` is " +
        "owner-only, and `owner` cannot be assigned here at all.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({
        $ref: "#/components/schemas/AddCommunityMemberRequest",
      }),
      responses: {
        "201": jsonResponse("Member added", memberEnvelope),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/communities/{slug}/moderators": {
    get: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "The moderating roster",
      description:
        "Owner, admins, and moderators, owner first. Unpaginated — a short " +
        "bounded set, and the list the shipped sidebar renders.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse("The moderating members", moderatorsEnvelope),
        ...errorResponses("404", "422"),
      },
    },
  },

  "/communities/{slug}/join": {
    post: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Join a community",
      description:
        "Public and unlisted communities are joined immediately. A private one is " +
        "a 404 to a non-member, so it never reaches the join rule; a caller who " +
        "*can* see it and still may not join gets 403. A second join is 409 — the " +
        "unique constraint is the arbiter, and the counter increment rolls back " +
        "with the losing insert.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "201": jsonResponse(
          "Joined",
          envelopeOf({
            type: "object",
            required: ["viewer"],
            properties: {
              viewer: { $ref: "#/components/schemas/CommunityViewerState" },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/communities/{slug}/leave": {
    delete: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Leave a community",
      description:
        "422 for the owner: `Community.ownerId` must always have a membership row, " +
        "so ownership is transferred first. 409 when the caller was never a member.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      responses: {
        "200": jsonResponse(
          "Left",
          envelopeOf({
            type: "object",
            required: ["left"],
            properties: { left: { type: "boolean" } },
          }),
        ),
        ...errorResponses("401", "404", "409", "422"),
      },
    },
  },

  "/communities/{slug}/members/{username}": {
    patch: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Change a member's role",
      description:
        "The caller must outrank the member's current role **and** be permitted to " +
        "grant the new one. An admin can therefore manage moderators and members " +
        "but neither promote to admin nor demote a peer. The owner's own role " +
        "cannot be changed, and `owner` is never assignable here.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, usernameParam],
      requestBody: requestBody({ $ref: "#/components/schemas/CommunityRoleRequest" }),
      responses: {
        "200": jsonResponse("Role updated", memberEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Remove a member",
      description:
        "A member may always remove themselves; removing anyone else requires " +
        "outranking them. The owner cannot be removed by anyone (422). Removing " +
        "someone who is not a member is 404.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, usernameParam],
      responses: {
        "200": jsonResponse(
          "Member removed",
          envelopeOf({
            type: "object",
            required: ["removed"],
            properties: { removed: { type: "boolean" } },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/transfer": {
    post: {
      tags: [COMMUNITY_MEMBERS_TAG],
      summary: "Transfer ownership",
      description:
        "Owner of record only — not a community admin, and not a platform admin. " +
        "One transaction moves `ownerId`, promotes the successor's membership to " +
        "`owner`, demotes the previous owner to `admin`, and counts the successor " +
        "if they were not already a member.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/TransferOwnershipRequest" }),
      responses: {
        "200": jsonResponse("Ownership transferred", moderatorsEnvelope),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/communities/{slug}/rules": {
    put: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Replace the rule list",
      description:
        "Replace-set: the submitted array *is* the rule list and its index becomes " +
        "the stored position. An empty array clears the rules. Requires " +
        "`manage_rules` — owner or admin; a moderator cannot rewrite the charter.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/ReplaceRulesRequest" }),
      responses: {
        "200": jsonResponse("Rules updated", communityOnlyEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/tags": {
    put: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Replace the tag set",
      description:
        "Attaches only to existing `Tag` rows — an unknown reference is 422 rather " +
        "than an implicit create. `Tag.usageCount` is shared with project tags and " +
        "moved transactionally, guarded so it can never go negative.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/ReplaceTagsRequest" }),
      responses: {
        "200": jsonResponse("Tags updated", communityOnlyEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/events": {
    get: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Community events",
      parameters: [
        slugParam,
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        {
          name: "includePast",
          in: "query",
          required: false,
          schema: { type: "boolean", default: false },
        },
      ],
      responses: {
        "200": jsonResponse("The community's events", eventListEnvelope),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Create an event",
      description:
        "Requires `manage_events` — moderator and above. `attendeeCount` is never " +
        "accepted and never returned: no RSVP model exists, so nothing could " +
        "maintain it.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/CreateEventRequest" }),
      responses: {
        "201": jsonResponse("Event created", eventEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/events/{id}": {
    patch: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Update an event",
      description:
        "A patch moving only `startsAt` is validated against the **stored** " +
        "`endsAt`, so a one-field change cannot invert an event.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/UpdateEventRequest" }),
      responses: {
        "200": jsonResponse("Event updated", eventEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Delete an event",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      responses: {
        "200": jsonResponse(
          "Event deleted",
          envelopeOf({
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              deleted: { type: "boolean", const: true },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/pins": {
    get: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Pinned post ids",
      description: "A post deleted after being pinned drops out of this list.",
      parameters: [slugParam],
      responses: {
        "200": jsonResponse("The pinned post ids", pinsEnvelope),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Pin a post",
      description:
        "Requires `pin_posts` — moderator and above. The post must already belong " +
        "to this community and not be deleted; anything else is 404, which avoids " +
        "confirming a post the caller may have no right to know about. A duplicate " +
        "pin is 409 — the composite primary key is the arbiter.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/PinPostRequest" }),
      responses: {
        "201": jsonResponse("Post pinned", pinsEnvelope),
        ...errorResponses("401", "403", "404", "409", "422"),
      },
    },
  },

  "/communities/{slug}/pins/{id}": {
    delete: {
      tags: [COMMUNITY_RESOURCES_TAG],
      summary: "Unpin a post",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam, childIdParam],
      responses: {
        "200": jsonResponse("Post unpinned", pinsEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/communities/{slug}/posts": {
    get: {
      tags: [COMMUNITY_POSTS_TAG],
      summary: "The community's posts",
      description:
        "Cursor-paginated, and distinct from the global feed: the feed admits only " +
        "public communities, so a private community's members read its posts here. " +
        "Soft-deleted posts and blocked authors are excluded.",
      parameters: [slugParam, ...cursorParams],
      responses: {
        "200": jsonResponse("A cursor page of posts", feedEnvelope),
        ...errorResponses("404", "422"),
      },
    },
    post: {
      tags: [COMMUNITY_POSTS_TAG],
      summary: "Post into a community",
      description:
        "The **only** way a post acquires a `communityId`, and it comes from this " +
        "route rather than the body — `CreatePostRequest` has no such field. " +
        "Requires `create_post`, which is a membership grant: a non-member is " +
        "refused even in a public community, and so is a platform admin who has " +
        "not joined, because posting is participation rather than moderation.",
      security: [{ bearerAuth: [] }],
      parameters: [slugParam],
      requestBody: requestBody({ $ref: "#/components/schemas/CreatePostRequest" }),
      responses: {
        "201": jsonResponse("Post created", postEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },
};

/* ── Messaging paths (Phase 8) ──────────────────────────────────────────── */

const MESSAGES_TAG = "Messaging";
const MESSAGE_REACTIONS_TAG = "Message Reactions";
const MESSAGE_READ_TAG = "Read Receipts";

const conversationIdParam = {
  name: "conversationId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};

const messageIdParam = {
  name: "messageId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};

const conversationEnvelope = envelopeOf({
  type: "object",
  properties: { conversation: { $ref: "#/components/schemas/Conversation" } },
});

const messageEnvelope = envelopeOf({
  type: "object",
  properties: { message: { $ref: "#/components/schemas/Message" } },
});

const conversationPageEnvelope = envelopeOf({
  type: "object",
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/Conversation" } },
    nextCursor: { type: ["string", "null"], format: "uuid" },
  },
});

const messagePageEnvelope = envelopeOf({
  type: "object",
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/Message" } },
    nextCursor: { type: ["string", "null"], format: "uuid" },
  },
});

/**
 * Note what no messaging read advertises: **403**.
 *
 * A conversation the caller does not belong to answers 404, and so does one
 * hidden by a block — the same non-disclosure rule the community reads follow.
 * 403 appears only on two writes where the caller demonstrably already knows
 * the resource exists: editing someone else's message, and sending to someone
 * whose contact policy has since tightened.
 */
const messagePaths: OpenApiObject = {
  "/messages/conversations": {
    get: {
      tags: [MESSAGES_TAG],
      summary: "The caller's conversations",
      description:
        "Newest activity first. Each entry carries its last live message and the " +
        "caller's own unread count; a conversation with no messages sorts last.",
      security: [{ bearerAuth: [] }],
      parameters: cursorParams,
      responses: {
        "200": jsonResponse("Conversations", conversationPageEnvelope),
        ...errorResponses("401", "422"),
      },
    },
    post: {
      tags: [MESSAGES_TAG],
      summary: "Open a direct conversation",
      description:
        "Idempotent: 201 when a conversation was created, 200 when an existing one " +
        "was returned. The caller is always one participant and the body names only " +
        "the other. Blocking, an unknown user, and a `followers`-only recipient the " +
        "caller does not follow are all 404 — indistinguishable on purpose, so the " +
        "endpoint cannot be used to probe either setting.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        $ref: "#/components/schemas/CreateConversationRequest",
      }),
      responses: {
        "200": jsonResponse("Existing conversation", conversationEnvelope),
        "201": jsonResponse("Conversation created", conversationEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/conversations/{conversationId}": {
    get: {
      tags: [MESSAGES_TAG],
      summary: "One conversation",
      security: [{ bearerAuth: [] }],
      parameters: [conversationIdParam],
      responses: {
        "200": jsonResponse("The conversation", conversationEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/conversations/{conversationId}/messages": {
    get: {
      tags: [MESSAGES_TAG],
      summary: "Message history",
      description:
        "Cursor-paginated, newest first, riding the " +
        "`(conversationId, createdAt DESC)` index. Deleted messages are omitted.",
      security: [{ bearerAuth: [] }],
      parameters: [conversationIdParam, ...cursorParams],
      responses: {
        "200": jsonResponse("Messages", messagePageEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
    post: {
      tags: [MESSAGES_TAG],
      summary: "Send a message",
      description:
        "The sender is the token holder; a `senderId` in the body is stripped. A " +
        "message must carry content or at least one attachment. 403 when the " +
        "recipient's `whoCanMessage` has since tightened to `followers` and the " +
        "sender does not follow them — history stays readable, only the write closes.",
      security: [{ bearerAuth: [] }],
      parameters: [conversationIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/SendMessageRequest" }),
      responses: {
        "201": jsonResponse("Message sent", messageEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/messages/conversations/{conversationId}/messages/search": {
    get: {
      tags: [MESSAGES_TAG],
      summary: "Search within a conversation",
      description:
        "Case-insensitive substring match, scoped to this conversation by the path. " +
        "There is no cross-conversation variant; global search is a later phase.",
      security: [{ bearerAuth: [] }],
      parameters: [
        conversationIdParam,
        {
          name: "q",
          in: "query",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 100 },
        },
        ...cursorParams,
      ],
      responses: {
        "200": jsonResponse("Matching messages", messagePageEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/conversations/{conversationId}/read": {
    post: {
      tags: [MESSAGE_READ_TAG],
      summary: "Mark a conversation read",
      description:
        "Moves only the caller's own watermark, and only forward — a late request " +
        "from a second device cannot drag it backwards. Omitting `messageId` marks " +
        "everything currently in the thread.",
      security: [{ bearerAuth: [] }],
      parameters: [conversationIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/MarkReadRequest" }, false),
      responses: {
        "200": jsonResponse(
          "Read receipt",
          envelopeOf({ $ref: "#/components/schemas/ReadReceipt" }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/conversations/{conversationId}/unread": {
    get: {
      tags: [MESSAGE_READ_TAG],
      summary: "Unread count",
      description:
        "One indexed COUNT against the caller's watermark. Never loads messages.",
      security: [{ bearerAuth: [] }],
      parameters: [conversationIdParam],
      responses: {
        "200": jsonResponse(
          "Unread count",
          envelopeOf({
            type: "object",
            required: ["conversationId", "unreadCount"],
            properties: {
              conversationId: { type: "string", format: "uuid" },
              unreadCount: { type: "integer", minimum: 0 },
            },
          }),
        ),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/{messageId}": {
    patch: {
      tags: [MESSAGES_TAG],
      summary: "Edit a message",
      description:
        "The author only — no admin or moderator branch. Attachments cannot be " +
        "changed by an edit: re-pointing one after the fact would let a sender swap " +
        "a file the recipient has already trusted. 403 for another member of the " +
        "same conversation (the message is not a secret from them), 404 for anyone " +
        "outside it.",
      security: [{ bearerAuth: [] }],
      parameters: [messageIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/EditMessageRequest" }),
      responses: {
        "200": jsonResponse("Message updated", messageEnvelope),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
    delete: {
      tags: [MESSAGES_TAG],
      summary: "Delete a message",
      description:
        "Soft delete — the row, its attachments, and its reactions all survive; the " +
        "message stops being returned by any read path. The author only.",
      security: [{ bearerAuth: [] }],
      parameters: [messageIdParam],
      responses: {
        "200": jsonResponse(
          "Message deleted",
          envelopeOf({
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              conversationId: { type: "string", format: "uuid" },
            },
          }),
        ),
        ...errorResponses("401", "403", "404", "422"),
      },
    },
  },

  "/messages/{messageId}/reactions": {
    post: {
      tags: [MESSAGE_REACTIONS_TAG],
      summary: "Add a reaction",
      description:
        "Idempotent — `@@unique([messageId, userId, emoji])` is the arbiter, so a " +
        "double tap is 201 with an unchanged count rather than a 409 the UI would " +
        "have to explain.",
      security: [{ bearerAuth: [] }],
      parameters: [messageIdParam],
      requestBody: requestBody({ $ref: "#/components/schemas/AddReactionRequest" }),
      responses: {
        "201": jsonResponse("Reaction added", messageEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },

  "/messages/{messageId}/reactions/{emoji}": {
    delete: {
      tags: [MESSAGE_REACTIONS_TAG],
      summary: "Remove a reaction",
      description: "Removes only the caller's own reaction, never anyone else's.",
      security: [{ bearerAuth: [] }],
      parameters: [
        messageIdParam,
        {
          name: "emoji",
          in: "path",
          required: true,
          description: "Percent-encoded.",
          schema: { type: "string", minLength: 1, maxLength: 32 },
        },
      ],
      responses: {
        "200": jsonResponse("Reaction removed", messageEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },
};

/* ── Notification paths (Phase 9) ───────────────────────────────────────── */

const NOTIFICATIONS_TAG = "Notifications";

const notificationIdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};

const notificationEnvelope = envelopeOf({
  type: "object",
  properties: { notification: { $ref: "#/components/schemas/Notification" } },
});

const notificationPageEnvelope = envelopeOf({
  type: "object",
  required: ["items", "nextCursor", "unreadCount"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/Notification" } },
    nextCursor: { type: ["string", "null"], format: "uuid" },
    unreadCount: {
      type: "integer",
      minimum: 0,
      description: "Served alongside the page so the badge and the list arrive together.",
    },
  },
});

/**
 * Note what is absent: **no `POST /notifications` and no `DELETE`.**
 *
 * Notifications are generated by the server in response to domain events. A
 * create endpoint would be a way to write arbitrary text into another user's
 * panel, and no specification, PRD line, or frontend affordance asks for
 * deletion — the shipped panel offers "mark all as read" and nothing else.
 *
 * No read advertises **403** either: a notification belonging to someone else
 * and one that never existed both answer 404, so the endpoint cannot be used
 * to discover which ids are real.
 */
const notificationPaths: OpenApiObject = {
  "/notifications": {
    get: {
      tags: [NOTIFICATIONS_TAG],
      summary: "The caller's notifications",
      description:
        "Newest first, cursor-paginated, riding the `(userId, createdAt DESC)` " +
        "index. There is no parameter for whose notifications to read — the " +
        "recipient is always the token holder.",
      security: [{ bearerAuth: [] }],
      parameters: [
        ...cursorParams,
        {
          name: "unreadOnly",
          in: "query",
          required: false,
          schema: { type: "boolean", default: false },
          description:
            "The only filter. Filtering by type would be the beginning of " +
            "notification search, which belongs to a later phase.",
        },
      ],
      responses: {
        "200": jsonResponse("Notifications", notificationPageEnvelope),
        ...errorResponses("401", "422"),
      },
    },
  },

  "/notifications/unread": {
    get: {
      tags: [NOTIFICATIONS_TAG],
      summary: "Unread count",
      description:
        "One indexed COUNT against `(userId, isRead)`. Loads no notifications.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Unread count",
          envelopeOf({
            type: "object",
            required: ["unreadCount"],
            properties: { unreadCount: { type: "integer", minimum: 0 } },
          }),
        ),
        ...errorResponses("401"),
      },
    },
  },

  "/notifications/read-all": {
    post: {
      tags: [NOTIFICATIONS_TAG],
      summary: "Mark every notification read",
      description:
        "Affects only the caller's own rows. `markedRead: 0` is a success — the " +
        "caller asked for a state that already held — not a miss.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Notifications marked as read",
          envelopeOf({
            type: "object",
            required: ["markedRead", "unreadCount"],
            properties: {
              markedRead: { type: "integer", minimum: 0 },
              unreadCount: { type: "integer", minimum: 0 },
            },
          }),
        ),
        ...errorResponses("401"),
      },
    },
  },

  "/notifications/{id}/read": {
    post: {
      tags: [NOTIFICATIONS_TAG],
      summary: "Mark one notification read",
      description:
        "Idempotent: a second call returns the notification unchanged and " +
        "preserves the original `readAt`, rather than re-stamping it to a later " +
        "time than the user actually read it. A notification belonging to " +
        "someone else is 404, identical to one that does not exist.",
      security: [{ bearerAuth: [] }],
      parameters: [notificationIdParam],
      responses: {
        "200": jsonResponse("Notification marked as read", notificationEnvelope),
        ...errorResponses("401", "404", "422"),
      },
    },
  },
};

/* ── Search paths ───────────────────────────────────────────────────────── */

const SEARCH_TAG = "Search";

/**
 * One endpoint (ruling D5). ARCHITECTURE §29 names `/api/v1/search` and
 * nothing else, so the entity filter is a query parameter rather than a path
 * segment: one contract, one rate limiter, one place authentication is decided.
 */
const searchPaths: OpenApiObject = {
  "/search": {
    get: {
      tags: [SEARCH_TAG],
      summary: "Search users, projects, communities, posts, and tags",
      description:
        "Optional authentication. An anonymous caller sees strictly public " +
        "content; a signed-in caller additionally sees their own private and " +
        "unlisted projects, the private projects and communities they belong " +
        "to, their own non-public posts, and followers-only profiles they " +
        "follow. Authenticating widens *evaluation*, never authority — a " +
        "platform admin sees exactly what an ordinary member sees.\n\n" +
        "Results are grouped by entity, and all five groups are always " +
        "present: a group excluded by `type` comes back empty with a zero " +
        "total rather than being omitted. Each group carries its own offset " +
        "pagination, counted under the same visibility filter that produced " +
        "its rows, so a total can never reveal a row the caller may not see.\n\n" +
        "There is no relevance ranking and no relevance sort — matching is " +
        "case-insensitive substring containment, which yields a boolean rather " +
        "than a score. Ordering is explicit and deterministic.\n\n" +
        "Rate limited more tightly than the general API surface " +
        "(ARCHITECTURE §28): one search request runs five substring scans.",
      security: [{}, { bearerAuth: [] }],
      parameters: [
        {
          name: "q",
          in: "query",
          required: true,
          description:
            "The search term. Trimmed and whitespace-collapsed before " +
            "validation, so a whitespace-only value is rejected. A value made " +
            "entirely of SQL LIKE wildcards (`%`, `_`) is also rejected: it " +
            "would match every row and turn search into a bulk export.",
          schema: { type: "string", minLength: 1, maxLength: 100 },
        },
        {
          name: "type",
          in: "query",
          required: false,
          description: "Restricts the search to one entity group.",
          schema: {
            type: "string",
            enum: ["all", "users", "projects", "communities", "posts", "tags"],
            default: "all",
          },
        },
        {
          name: "sort",
          in: "query",
          required: false,
          description:
            "`recent` orders by creation time; `popular` orders by each " +
            "entity's own popularity counter. Both break ties on id so offset " +
            "paging is stable. There is deliberately no `relevance` value.",
          schema: { type: "string", enum: ["recent", "popular"], default: "recent" },
        },
        {
          name: "page",
          in: "query",
          required: false,
          description: "1-based, applied to every group.",
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          description:
            "Page size per group. Values above the maximum are clamped rather " +
            "than rejected.",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": jsonResponse(
          "Grouped search results. An empty result is a 200 with empty groups, " +
            "never a 404 — a query that matched nothing and a query whose " +
            "matches are all hidden are deliberately indistinguishable.",
          envelopeOf({ $ref: "#/components/schemas/SearchResults" }),
        ),
        ...errorResponses("422", "429"),
      },
    },
  },
};

/* ── Moderation paths (Phase 11) ────────────────────────────────────────── */

const MODERATION_TAG = "Moderation";
const ADMIN_TAG = "Admin";

const reportRef = { $ref: "#/components/schemas/Report" };
const reportDetailRef = { $ref: "#/components/schemas/ReportDetail" };

const REPORT_TARGET_ENUM = [
  "user",
  "post",
  "comment",
  "project",
  "community",
  "message",
] as const;

const REPORT_STATUS_ENUM = ["pending", "reviewing", "resolved", "dismissed"] as const;

const reportListResponse = {
  allOf: [
    { $ref: "#/components/schemas/SuccessEnvelope" },
    {
      type: "object",
      required: ["pagination"],
      properties: {
        data: { type: "array", items: reportDetailRef },
        pagination: { $ref: "#/components/schemas/Pagination" },
      },
    },
  ],
};

/**
 * Two authorization tiers on one router (ARCHITECTURE §25, §29).
 *
 * Filing is `requireAuth` — PRD §17 opens with "Users must be able to report".
 * Everything else is staff-only, so every other operation advertises 403.
 */
const moderationPaths: OpenApiObject = {
  "/moderation/reports": {
    post: {
      tags: [MODERATION_TAG],
      summary: "File a report",
      description:
        "Any authenticated user may file a report. **Blocking is deliberately " +
        "not consulted** — a reporter who has blocked the person they are " +
        "reporting still files successfully, because the user most likely to " +
        "have blocked a harasser is the one who needs to report them. Nothing " +
        "else about blocking is weakened.\n\n" +
        "The reporter is taken from the access token; a `reporterId` in the " +
        "body is stripped before validation and has no effect. `status` is " +
        "likewise not accepted — every report is created `pending`.\n\n" +
        "Rate limited more tightly than the general API surface: mass filing " +
        "is a denial of service against moderators rather than against the " +
        "server.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["targetType", "targetId", "reason"],
        properties: {
          targetType: { type: "string", enum: [...REPORT_TARGET_ENUM] },
          targetId: stringField({ format: "uuid" }),
          reason: {
            type: "string",
            enum: [
              "spam",
              "harassment",
              "inappropriate_content",
              "impersonation",
              "other",
            ],
          },
          details: stringField({ maxLength: 2000, default: "" }),
        },
      }),
      responses: {
        "201": jsonResponse(
          "Report filed",
          envelopeOf({ type: "object", properties: { report: reportRef } }),
        ),
        ...errorResponses("401", "404", "422", "429"),
      },
    },
    get: {
      tags: [MODERATION_TAG],
      summary: "Read the moderation queue",
      description:
        "Moderator, community admin, or platform admin only. Ordered **oldest " +
        "first**, which is what the schema's `reports(status, createdAt)` index " +
        "exists for — a queue that surfaced the newest report first would " +
        "starve the oldest. Ties break on id so offset paging is stable.\n\n" +
        "`status` accepts all four lifecycle states including `reviewing`. The " +
        "shipped admin UI filters on three and never sends the fourth; the " +
        "backend keeps it because it is the state that lets a moderator claim " +
        "a report.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...REPORT_STATUS_ENUM] },
        },
        {
          name: "targetType",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...REPORT_TARGET_ENUM] },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": jsonResponse("A page of the moderation queue", reportListResponse),
        ...errorResponses("401", "403", "422", "429"),
      },
    },
  },

  "/moderation/reports/{id}": {
    get: {
      tags: [MODERATION_TAG],
      summary: "Read one report",
      description:
        "Staff only. A reporter cannot read their own report back: it carries " +
        "the reviewer's identity, the denormalized target author, and a " +
        "free-text resolution, none of which is the filer's business.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: stringField({ format: "uuid" }),
        },
      ],
      responses: {
        "200": jsonResponse(
          "The report",
          envelopeOf({ type: "object", properties: { report: reportDetailRef } }),
        ),
        ...errorResponses("401", "403", "404", "422", "429"),
      },
    },
    patch: {
      tags: [MODERATION_TAG],
      summary: "Move a report through its lifecycle",
      description:
        "Legal transitions are `pending → reviewing → resolved` and " +
        "`pending → reviewing → dismissed`. `resolved` and `dismissed` are " +
        "terminal, and there is no shortcut from `pending` straight to a " +
        "closed state — a report must be claimed before it can be closed, " +
        "which is what makes `reviewerId` meaningful.\n\n" +
        "An illegal transition is **409**, not 422: the value is well-formed " +
        "and would be legal from another state. Two moderators claiming the " +
        "same pending report race in the database; the loser gets the same " +
        "409, which is the truthful answer.\n\n" +
        "`reviewerId` and `resolvedAt` are server-owned and are stripped from " +
        "the body if sent.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: stringField({ format: "uuid" }),
        },
      ],
      requestBody: requestBody({
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: [...REPORT_STATUS_ENUM] },
          resolution: stringField({ maxLength: 2000 }),
        },
      }),
      responses: {
        "200": jsonResponse(
          "The updated report",
          envelopeOf({ type: "object", properties: { report: reportDetailRef } }),
        ),
        ...errorResponses("401", "403", "404", "409", "422", "429"),
      },
    },
  },

  "/moderation/actions": {
    post: {
      tags: [MODERATION_TAG],
      summary: "Record a moderation action",
      description:
        "The seven verbs the schema carries. Four are named by ARCHITECTURE " +
        "§25 — `warning`, `content_removal`, `suspension` (temporary), and " +
        "`ban` (permanent); the other three are `shadow_ban`, `unban`, and " +
        "`reinstate`.\n\n" +
        "**Rank decides who may act on whom.** A moderator may action members " +
        "and verified builders, but not another moderator, a community admin, " +
        "or a platform admin — and nobody may action themselves, which rules " +
        "out self-ban and self-suspension. Refusals are 403 with one message " +
        "for every case, so the endpoint cannot be used to map other users' " +
        "roles.\n\n" +
        "Account verbs take a `user` target; `content_removal` takes any " +
        "other. Only `suspension` may carry `expiresAt`, and every " +
        "`suspension` must — the schema documents a null expiry as permanent, " +
        "so a suspension without one would be a ban wearing the wrong name.\n\n" +
        "The mutation, the `ModerationAction` row, and the `AuditLog` row " +
        "commit in **one transaction**: no action can land without its audit " +
        "record. Content removal reuses each domain's existing `deletedAt` " +
        "semantics, including its counter side-effects.\n\n" +
        "`moderatorId` is taken from the access token and is stripped from the " +
        "body if sent.",
      security: [{ bearerAuth: [] }],
      requestBody: requestBody({
        type: "object",
        required: ["action", "targetType", "targetId"],
        properties: {
          action: {
            type: "string",
            enum: [
              "warning",
              "content_removal",
              "suspension",
              "ban",
              "shadow_ban",
              "unban",
              "reinstate",
            ],
          },
          targetType: { type: "string", enum: [...REPORT_TARGET_ENUM] },
          targetId: stringField({ format: "uuid" }),
          reason: stringField({ maxLength: 1000, default: "" }),
          expiresAt: stringField({
            format: "date-time",
            description: "Required for `suspension`, forbidden for every other verb.",
          }),
          reportId: stringField({ format: "uuid" }),
        },
      }),
      responses: {
        "201": jsonResponse(
          "The recorded action",
          envelopeOf({ $ref: "#/components/schemas/ModerationActionResult" }),
        ),
        ...errorResponses("400", "401", "403", "404", "422", "429"),
      },
    },
  },
};

/* ── Admin paths (Phase 11) ─────────────────────────────────────────────── */

const adminUserListResponse = {
  allOf: [
    { $ref: "#/components/schemas/SuccessEnvelope" },
    {
      type: "object",
      required: ["pagination"],
      properties: {
        data: {
          type: "array",
          items: { $ref: "#/components/schemas/AdminUserSummary" },
        },
        pagination: { $ref: "#/components/schemas/Pagination" },
      },
    },
  ],
};

const auditLogListResponse = {
  allOf: [
    { $ref: "#/components/schemas/SuccessEnvelope" },
    {
      type: "object",
      required: ["pagination"],
      properties: {
        data: { type: "array", items: { $ref: "#/components/schemas/AuditLog" } },
        pagination: { $ref: "#/components/schemas/Pagination" },
      },
    },
  ],
};

const USER_ROLE_ENUM = [
  "guest",
  "member",
  "verified_builder",
  "moderator",
  "community_admin",
  "platform_admin",
] as const;

const MODERATION_STATUS_ENUM = ["active", "banned", "shadow_banned"] as const;

const adminPaths: OpenApiObject = {
  "/admin/users": {
    get: {
      tags: [ADMIN_TAG],
      summary: "List accounts for user management",
      description:
        "Moderator, community admin, or platform admin. Newest account first, " +
        "tie-broken by id so offset paging is stable. Soft-deleted accounts " +
        "are excluded.\n\n" +
        "**`email` is deliberately absent from the projection.** A paginated " +
        "table of every account's address is a credential-stuffing target that " +
        "no listed requirement asks for; an administrator who needs one opens " +
        "that user's profile, where the existing `canSeeEmail` rule applies.\n\n" +
        "There is no free-text search parameter — user search is Phase 10's " +
        "surface and this is not it.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "role",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...USER_ROLE_ENUM] },
        },
        {
          name: "status",
          in: "query",
          required: false,
          schema: { type: "string", enum: [...MODERATION_STATUS_ENUM] },
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": jsonResponse("A page of accounts", adminUserListResponse),
        ...errorResponses("401", "403", "422", "429"),
      },
    },
  },

  "/admin/users/{id}/role": {
    patch: {
      tags: [ADMIN_TAG],
      summary: "Change a user's role",
      description:
        "**`platform_admin` only.** The most privileged write in the API, and " +
        "the one place the backend is deliberately stricter than the shipped " +
        "frontend: `user-row.tsx` renders a role selector containing " +
        "`platform_admin` to every staff role, so mirroring it with " +
        "`requireAdmin` would let any moderator promote themselves.\n\n" +
        "Also refused: changing your own role, assigning `guest` (the " +
        "not-signed-in sentinel, never a real role), and acting on an account " +
        "whose role equals or outranks yours — which means no platform admin " +
        "can promote or demote another platform admin.\n\n" +
        "The write is guarded on the role the caller observed, so two " +
        "simultaneous changes cannot silently overwrite one another (409). " +
        "Audited as `ROLE_CHANGED` in the same transaction.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: stringField({ format: "uuid" }),
        },
      ],
      requestBody: requestBody({
        type: "object",
        required: ["role"],
        properties: { role: { type: "string", enum: [...USER_ROLE_ENUM] } },
      }),
      responses: {
        "200": jsonResponse(
          "The updated account",
          envelopeOf({
            type: "object",
            properties: { user: { $ref: "#/components/schemas/AdminUserSummary" } },
          }),
        ),
        ...errorResponses("401", "403", "404", "409", "422", "429"),
      },
    },
  },

  "/admin/users/{id}/status": {
    patch: {
      tags: [ADMIN_TAG],
      summary: "Change a user's moderation status",
      description:
        "Takes a *state* because that is what the shipped admin table sends, " +
        "and translates it into the moderation verb that gets recorded: " +
        "`banned` → `ban`, `shadow_banned` → `shadow_ban`, and `active` → " +
        "`unban` or `reinstate` depending on what is being lifted.\n\n" +
        "The restoration half of that mapping — `unban` for a ban or " +
        "suspension, `reinstate` for a shadow ban — is an **implementation " +
        "inference, not a specified requirement**. The shipped admin table " +
        "sends one `Restore` action for both non-active statuses and names no " +
        "verb, and no specification defines either member, so the server " +
        "chooses. See `docs/MODERATION.md` for the sources checked.\n\n" +
        "Delegates to the same transactional path `POST /moderation/actions` " +
        "uses, so there is exactly one code path that writes `User.status` and " +
        "it is the one that writes the audit row alongside it. The same rank " +
        "rules apply, including the refusal to act on yourself.\n\n" +
        "Setting the status an account already holds is a 409 — a moderation " +
        "action that changed nothing is noise in a trail whose value comes " +
        "from every row meaning something.\n\n" +
        "There is no `expiresAt` here: a *temporary* suspension is a verb with " +
        "its own requirements and is filed through `POST /moderation/actions`.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: stringField({ format: "uuid" }),
        },
      ],
      requestBody: requestBody({
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: [...MODERATION_STATUS_ENUM] },
          reason: stringField({ maxLength: 1000, default: "" }),
        },
      }),
      responses: {
        "200": jsonResponse(
          "The recorded action",
          envelopeOf({ $ref: "#/components/schemas/ModerationActionResult" }),
        ),
        ...errorResponses("401", "403", "404", "409", "422", "429"),
      },
    },
  },

  "/admin/stats": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Platform overview counters",
      description:
        "The four counters the shipped Overview and Analytics pages render. " +
        "Soft-deleted rows are excluded so the numbers describe live content.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Platform statistics",
          envelopeOf({ $ref: "#/components/schemas/AdminOverviewStats" }),
        ),
        ...errorResponses("401", "403", "429"),
      },
    },
  },

  "/admin/analytics/signups": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Weekly signup counts",
      description:
        "Eight weekly buckets ending with the current week, oldest first — the " +
        "series the shipped growth chart plots. Buckets are half-open and " +
        "aligned to UTC midnight, so a signup falls in exactly one bucket " +
        "regardless of the deployment's timezone.\n\n" +
        "Computed as eight indexed range counts on `users(createdAt)`, not raw " +
        "SQL and not an in-memory bucketing of every recent signup.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Weekly signups",
          envelopeOf({
            type: "object",
            required: ["signups"],
            properties: {
              signups: {
                type: "array",
                items: { $ref: "#/components/schemas/WeeklySignup" },
              },
            },
          }),
        ),
        ...errorResponses("401", "403", "429"),
      },
    },
  },

  "/admin/analytics/reports-by-reason": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Report counts by reason",
      description:
        "Reasons with a zero count are omitted, matching the shipped chart's " +
        "own filter — an empty bar renders as a label with no mark and reads " +
        "as a rendering bug.",
      security: [{ bearerAuth: [] }],
      responses: {
        "200": jsonResponse(
          "Report counts by reason",
          envelopeOf({
            type: "object",
            required: ["reasons"],
            properties: {
              reasons: {
                type: "array",
                items: { $ref: "#/components/schemas/ReportsByReason" },
              },
            },
          }),
        ),
        ...errorResponses("401", "403", "429"),
      },
    },
  },

  "/admin/audit-logs": {
    get: {
      tags: [ADMIN_TAG],
      summary: "Read the audit trail",
      description:
        "**`platform_admin` only.** The trail records every login, password " +
        "change, role change, moderation action, IP address, and user agent on " +
        "the platform — the single most sensitive read surface in the API. TRD " +
        "§29 requires it not be editable by normal users; this restricts " +
        "*reading* to the one role that needs it, so a moderator reviewing " +
        "reports cannot pull the login history of the people they moderate.\n\n" +
        "Newest first, tie-broken by id — a moderation action and its own " +
        "audit record are frequently written in the same millisecond.\n\n" +
        "There is **no write endpoint and no delete endpoint**, for any role. " +
        "The table is append-only by design and the repository exposes an " +
        "insert and two reads and nothing else.",
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: "actorId",
          in: "query",
          required: false,
          schema: stringField({ format: "uuid" }),
        },
        {
          name: "action",
          in: "query",
          required: false,
          description: "Exact match on the audited verb, e.g. `USER_BANNED`.",
          schema: stringField({ minLength: 1, maxLength: 64 }),
        },
        {
          name: "targetType",
          in: "query",
          required: false,
          schema: {
            type: "string",
            enum: [
              "user",
              "post",
              "comment",
              "project",
              "community",
              "message",
              "conversation",
              "achievement",
            ],
          },
        },
        {
          name: "targetId",
          in: "query",
          required: false,
          schema: stringField({ format: "uuid" }),
        },
        {
          name: "page",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, default: 1 },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        "200": jsonResponse("A page of audit records", auditLogListResponse),
        ...errorResponses("401", "403", "422", "429"),
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
    { name: PROJECTS_TAG, description: "Projects, discovery, and the changelog" },
    { name: PROJECT_TEAM_TAG, description: "Members, roles, and ownership" },
    { name: PROJECT_ROADMAP_TAG, description: "Milestones and derived progress" },
    { name: PROJECT_ENGAGEMENT_TAG, description: "Likes, followers, and views" },
    { name: POSTS_TAG, description: "Posts, media, polls, likes, and bookmarks" },
    { name: COMMENTS_TAG, description: "Comments, replies, and comment likes" },
    { name: FEED_TAG, description: "The social feed and its filters" },
    { name: MESSAGES_TAG, description: "Direct conversations and messages" },
    { name: MESSAGE_REACTIONS_TAG, description: "Emoji reactions on messages" },
    { name: MESSAGE_READ_TAG, description: "Read watermarks and unread counts" },
    { name: NOTIFICATIONS_TAG, description: "In-app notifications and read state" },
    { name: SEARCH_TAG, description: "Cross-entity search over public content" },
    { name: MODERATION_TAG, description: "Reports and moderation actions" },
    { name: ADMIN_TAG, description: "User management, analytics, and the audit trail" },
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
      /* ── Communities (Phase 7) ───────────────────────────────────────── */

      Community: {
        type: "object",
        required: [
          "id",
          "slug",
          "name",
          "description",
          "avatarUrl",
          "bannerUrl",
          "category",
          "tags",
          "rules",
          "moderatorIds",
          "memberCount",
          "pinnedPostIds",
          "events",
          "createdAt",
          "visibility",
          "ownerId",
          "owner",
        ],
        description:
          "Mirrors the frontend's `Community` key for key, plus three additive " +
          "fields (`visibility`, `ownerId`, `owner`). `deletedAt` is never emitted: " +
          "it would let a client distinguish soft-deleted from never-existing, " +
          "which is the distinction the 404 exists to erase.",
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string", pattern: "^[a-z0-9-]+$" },
          name: { type: "string" },
          description: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          bannerUrl: { type: ["string", "null"] },
          category: { type: "string" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Display names, flattened from the shared Tag taxonomy.",
          },
          rules: {
            type: "array",
            items: { type: "string" },
            description: "In stored position order — the array sequence is the contract.",
          },
          moderatorIds: {
            type: "array",
            items: { type: "string", format: "uuid" },
            description: "Owner, admins, and moderators — everyone who runs the place.",
          },
          memberCount: { type: "integer", minimum: 0 },
          pinnedPostIds: { type: "array", items: { type: "string", format: "uuid" } },
          events: {
            type: "array",
            items: { $ref: "#/components/schemas/CommunityEvent" },
          },
          createdAt: { type: "string", format: "date-time" },
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          ownerId: { type: "string", format: "uuid" },
          owner: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      CommunitySummary: {
        type: "object",
        required: [
          "id",
          "slug",
          "name",
          "description",
          "category",
          "tags",
          "memberCount",
          "createdAt",
          "visibility",
        ],
        description:
          "The discovery-card shape. Rules, events, pins, and the moderator list " +
          "are per-community sub-queries the grid does not render.",
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          bannerUrl: { type: ["string", "null"] },
          category: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          memberCount: { type: "integer", minimum: 0 },
          createdAt: { type: "string", format: "date-time" },
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
        },
      },

      CommunityEvent: {
        type: "object",
        required: ["id", "title", "startsAt", "endsAt"],
        description:
          "The four fields the shipped widget reads. `attendeeCount` is " +
          "deliberately absent: no RSVP model exists, so no write path could move " +
          "it, and a permanent zero would read as 'nobody is attending'.",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: ["string", "null"], format: "date-time" },
        },
      },

      CommunityEventDetail: {
        allOf: [
          { $ref: "#/components/schemas/CommunityEvent" },
          {
            type: "object",
            required: ["description", "isOnline", "location"],
            properties: {
              description: { type: "string" },
              isOnline: { type: "boolean" },
              location: { type: ["string", "null"] },
            },
          },
        ],
      },

      CommunityMemberWithUser: {
        type: "object",
        required: ["userId", "role", "joinedAt", "user"],
        properties: {
          userId: { type: "string", format: "uuid" },
          role: { type: "string", enum: ["owner", "admin", "moderator", "member"] },
          joinedAt: { type: "string", format: "date-time" },
          user: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      CommunityViewerState: {
        type: "object",
        required: [
          "isOwner",
          "isMember",
          "role",
          "canJoin",
          "canPost",
          "canEdit",
          "canManageMembers",
          "canModerate",
        ],
        description:
          "Viewer-relative affordances, so the page renders Join/Leave and " +
          "moderation controls without a second request. There is deliberately no " +
          "field saying *why* access was granted.",
        properties: {
          isOwner: { type: "boolean" },
          isMember: { type: "boolean" },
          role: {
            oneOf: [
              { type: "string", enum: ["owner", "admin", "moderator", "member"] },
              { type: "null" },
            ],
          },
          canJoin: { type: "boolean" },
          canPost: { type: "boolean" },
          canEdit: { type: "boolean" },
          canManageMembers: { type: "boolean" },
          canModerate: { type: "boolean" },
        },
      },

      CreateCommunityRequest: {
        type: "object",
        required: ["name", "category"],
        description:
          "No `slug`, `ownerId`, or `memberCount`: all are server-owned. Unknown " +
          "keys are stripped rather than rejected, so they never reach a repository.",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          category: { type: "string", minLength: 1, maxLength: 60 },
          description: { type: "string", maxLength: 2000 },
          tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          avatarUrl: { type: ["string", "null"], maxLength: 500 },
          bannerUrl: { type: ["string", "null"], maxLength: 500 },
        },
      },

      UpdateCommunityRequest: {
        type: "object",
        minProperties: 1,
        description: "At least one field. The slug is immutable and absent here.",
        properties: {
          name: { type: "string", minLength: 2, maxLength: 80 },
          category: { type: "string", minLength: 1, maxLength: 60 },
          description: { type: "string", maxLength: 2000 },
          tags: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          avatarUrl: { type: ["string", "null"], maxLength: 500 },
          bannerUrl: { type: ["string", "null"], maxLength: 500 },
        },
      },

      AddCommunityMemberRequest: {
        type: "object",
        required: ["username"],
        properties: {
          username: { type: "string", pattern: "^[a-z0-9._]+$", maxLength: 30 },
          role: {
            type: "string",
            enum: ["admin", "moderator", "member"],
            default: "member",
            description: "`owner` is absent: ownership moves only through transfer.",
          },
        },
      },

      CommunityRoleRequest: {
        type: "object",
        required: ["role"],
        properties: {
          role: { type: "string", enum: ["admin", "moderator", "member"] },
        },
      },

      TransferOwnershipRequest: {
        type: "object",
        required: ["username"],
        properties: {
          username: { type: "string", pattern: "^[a-z0-9._]+$", maxLength: 30 },
        },
      },

      ReplaceRulesRequest: {
        type: "object",
        required: ["rules"],
        properties: {
          rules: {
            type: "array",
            maxItems: 30,
            items: { type: "string", minLength: 1, maxLength: 500 },
            description: "An empty array clears the rules.",
          },
        },
      },

      ReplaceTagsRequest: {
        type: "object",
        required: ["tags"],
        properties: {
          tags: {
            type: "array",
            maxItems: 10,
            items: { type: "string", minLength: 1, maxLength: 40 },
            description: "Display names or slugs; must already exist in the taxonomy.",
          },
        },
      },

      CreateEventRequest: {
        type: "object",
        required: ["title", "startsAt"],
        description: "`attendeeCount` is not accepted — there is no writer for it.",
        properties: {
          title: { type: "string", minLength: 2, maxLength: 140 },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: ["string", "null"], format: "date-time" },
          description: { type: "string", maxLength: 2000 },
          isOnline: { type: "boolean", default: true },
          location: { type: ["string", "null"], maxLength: 200 },
        },
      },

      UpdateEventRequest: {
        type: "object",
        minProperties: 1,
        properties: {
          title: { type: "string", minLength: 2, maxLength: 140 },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: ["string", "null"], format: "date-time" },
          description: { type: "string", maxLength: 2000 },
          isOnline: { type: "boolean" },
          location: { type: ["string", "null"], maxLength: 200 },
        },
      },

      PinPostRequest: {
        type: "object",
        required: ["postId"],
        properties: { postId: { type: "string", format: "uuid" } },
      },

      /* ── Messaging (Phase 8) ─────────────────────────────────────────── */

      MessageAttachment: {
        type: "object",
        required: ["id", "url", "type", "name", "sizeBytes"],
        properties: {
          id: { type: "string", format: "uuid" },
          url: stringField({
            description:
              "An opaque reference, not necessarily an absolute URL. Phase 8 " +
              "never fetches or stores bytes; uploads are a later phase.",
          }),
          type: { type: "string", enum: ["image", "file", "voice"] },
          name: stringField(),
          sizeBytes: {
            type: ["integer", "null"],
            description: "Client-reported. Null when not supplied.",
          },
        },
      },

      MessageReaction: {
        type: "object",
        required: ["emoji", "count", "userIds", "reactedByViewer"],
        properties: {
          emoji: stringField(),
          count: { type: "integer", minimum: 1 },
          userIds: { type: "array", items: { type: "string", format: "uuid" } },
          reactedByViewer: { type: "boolean" },
        },
      },

      Message: {
        type: "object",
        required: [
          "id",
          "conversationId",
          "senderId",
          "content",
          "attachments",
          "reactions",
          "seenByUserIds",
          "createdAt",
          "editedAt",
          "sender",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          conversationId: { type: "string", format: "uuid" },
          senderId: { type: "string", format: "uuid" },
          content: stringField(),
          attachments: {
            type: "array",
            items: { $ref: "#/components/schemas/MessageAttachment" },
          },
          reactions: {
            type: "array",
            items: { $ref: "#/components/schemas/MessageReaction" },
          },
          seenByUserIds: {
            type: "array",
            items: { type: "string", format: "uuid" },
            description:
              "Derived from each member's read watermark, not from a per-message " +
              "receipt table. The sender is always included.",
          },
          createdAt: stringField({ format: "date-time" }),
          editedAt: { type: ["string", "null"], format: "date-time" },
          sender: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      Conversation: {
        type: "object",
        required: [
          "id",
          "participantIds",
          "isGroup",
          "title",
          "lastMessage",
          "unreadCount",
          "createdAt",
          "lastMessageAt",
          "participants",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          participantIds: {
            type: "array",
            items: { type: "string", format: "uuid" },
            description: "Every live participant, the viewer included.",
          },
          isGroup: {
            type: "boolean",
            description:
              "Always false in Phase 8. The field exists because the schema and " +
              "the service abstractions are group-ready; group creation is not " +
              "implemented.",
          },
          title: { type: ["string", "null"] },
          lastMessage: {
            oneOf: [{ $ref: "#/components/schemas/Message" }, { type: "null" }],
            description:
              "The newest message that is not deleted, which may not be the one " +
              "`lastMessageAt` refers to.",
          },
          unreadCount: { type: "integer", minimum: 0 },
          createdAt: stringField({ format: "date-time" }),
          lastMessageAt: { type: ["string", "null"], format: "date-time" },
          participants: {
            type: "array",
            items: { $ref: "#/components/schemas/UserSummary" },
            description: "Every participant *except* the viewer.",
          },
        },
      },

      ReadReceipt: {
        type: "object",
        required: ["conversationId", "lastReadAt", "lastReadMessageId", "unreadCount"],
        properties: {
          conversationId: { type: "string", format: "uuid" },
          lastReadAt: { type: ["string", "null"], format: "date-time" },
          lastReadMessageId: { type: ["string", "null"], format: "uuid" },
          unreadCount: { type: "integer", minimum: 0 },
        },
      },

      CreateConversationRequest: {
        type: "object",
        required: ["username"],
        properties: {
          username: stringField({
            maxLength: 30,
            description:
              "The *other* participant. The caller is always the first, so there " +
              "is deliberately no participant array.",
          }),
        },
      },

      SendMessageRequest: {
        type: "object",
        properties: {
          content: stringField({ maxLength: 4000 }),
          attachments: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              required: ["url", "name"],
              properties: {
                url: stringField({ maxLength: 500 }),
                name: stringField({ maxLength: 200 }),
                type: {
                  type: "string",
                  enum: ["image", "file", "voice"],
                  default: "file",
                },
                sizeBytes: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        description:
          "At least one of `content` or `attachments` must be non-empty. There is " +
          "no `senderId`: the sender is the token holder.",
      },

      EditMessageRequest: {
        type: "object",
        required: ["content"],
        properties: { content: stringField({ minLength: 1, maxLength: 4000 }) },
      },

      MarkReadRequest: {
        type: "object",
        properties: {
          messageId: {
            type: "string",
            format: "uuid",
            description:
              "Optional. Omit to mark the whole thread. Must belong to this " +
              "conversation; an id from another thread is 404.",
          },
        },
      },

      AddReactionRequest: {
        type: "object",
        required: ["emoji"],
        properties: { emoji: stringField({ minLength: 1, maxLength: 32 }) },
      },

      /* ── Notifications (Phase 9) ─────────────────────────────────────── */

      NotificationActor: {
        type: "object",
        required: ["id", "username", "displayName", "avatarUrl"],
        properties: {
          id: { type: "string", format: "uuid" },
          username: stringField(),
          displayName: stringField(),
          avatarUrl: { type: ["string", "null"] },
        },
        description:
          "Four fields and no more. A notification needs a name, a handle to " +
          "link to, and an avatar — nothing about the actor's standing.",
      },

      Notification: {
        type: "object",
        required: [
          "id",
          "userId",
          "type",
          "actorId",
          "targetId",
          "entityType",
          "message",
          "isRead",
          "readAt",
          "createdAt",
          "actorName",
          "actorAvatarUrl",
          "actor",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          type: {
            type: "string",
            enum: [
              "like",
              "comment",
              "reply",
              "mention",
              "follower",
              "project_update",
              "invite",
              "project_invite",
              "community_invite",
              "message",
              "achievement",
              "moderation",
            ],
            description:
              "`achievement` and `moderation` are declared by the schema but " +
              "produced by no code path yet — the awarding engine and the " +
              "moderation surface are later phases.",
          },
          actorId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "Null for a system notification, and also null once the actor's " +
              "account is deleted — the notification itself survives.",
          },
          targetId: { type: ["string", "null"], format: "uuid" },
          entityType: {
            type: ["string", "null"],
            description: "Tells a client how to route the link on `targetId`.",
          },
          message: stringField({
            description:
              "Rendered at write time so the list needs no per-row joins. It is " +
              "a snapshot: an actor who later changes their display name does " +
              "not rewrite past notifications.",
          }),
          isRead: { type: "boolean" },
          readAt: { type: ["string", "null"], format: "date-time" },
          createdAt: stringField({ format: "date-time" }),
          actorName: { type: ["string", "null"] },
          actorAvatarUrl: { type: ["string", "null"] },
          actor: {
            oneOf: [{ $ref: "#/components/schemas/NotificationActor" }, { type: "null" }],
          },
        },
      },

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
      /**
       * Search result projections (Phase 10).
       *
       * Deliberately narrower than the domain schemas they resemble.
       * `SearchUser` carries six fields and no `email`, `role`, or `status`:
       * search is the widest read surface in the API, so it gets the narrowest
       * projection in it.
       */
      SearchUser: {
        type: "object",
        required: ["id", "username", "displayName", "builderRank", "avatarUrl", "bio"],
        properties: {
          id: stringField({ format: "uuid" }),
          username: { type: "string" },
          displayName: { type: "string" },
          builderRank: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          bio: { type: ["string", "null"] },
        },
      },

      SearchProject: {
        type: "object",
        required: ["id", "slug", "title", "description", "createdAt", "tags"],
        properties: {
          id: stringField({ format: "uuid" }),
          slug: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          coverImageUrl: { type: ["string", "null"] },
          status: { type: "string" },
          visibility: { type: "string" },
          likesCount: { type: "integer", minimum: 0 },
          followersCount: { type: "integer", minimum: 0 },
          createdAt: stringField({ format: "date-time" }),
          owner: {
            oneOf: [{ $ref: "#/components/schemas/SearchUser" }, { type: "null" }],
          },
          tags: { type: "array", items: { type: "string" } },
        },
      },

      SearchCommunity: {
        type: "object",
        required: ["id", "slug", "name", "description", "category", "createdAt", "tags"],
        properties: {
          id: stringField({ format: "uuid" }),
          slug: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          category: { type: "string" },
          visibility: { type: "string" },
          memberCount: { type: "integer", minimum: 0 },
          createdAt: stringField({ format: "date-time" }),
          tags: { type: "array", items: { type: "string" } },
        },
      },

      SearchPost: {
        type: "object",
        required: ["id", "type", "content", "createdAt"],
        properties: {
          id: stringField({ format: "uuid" }),
          type: { type: "string" },
          content: { type: "string" },
          visibility: { type: "string" },
          likesCount: { type: "integer", minimum: 0 },
          commentsCount: { type: "integer", minimum: 0 },
          createdAt: stringField({ format: "date-time" }),
          author: {
            oneOf: [{ $ref: "#/components/schemas/SearchUser" }, { type: "null" }],
          },
        },
      },

      SearchTag: {
        type: "object",
        required: ["id", "slug", "name", "usageCount"],
        properties: {
          id: stringField({ format: "uuid" }),
          slug: { type: "string" },
          name: { type: "string" },
          usageCount: { type: "integer", minimum: 0 },
        },
      },

      /**
       * One entity's page. `pagination.total` is counted under the same
       * visibility filter that produced `items`, so it never reports rows the
       * caller may not see.
       */
      SearchResults: {
        type: "object",
        required: [
          "query",
          "type",
          "sort",
          "users",
          "projects",
          "communities",
          "posts",
          "tags",
          "totalResults",
        ],
        properties: {
          query: stringField({ description: "The normalized term that was run." }),
          type: {
            type: "string",
            enum: ["all", "users", "projects", "communities", "posts", "tags"],
          },
          sort: { type: "string", enum: ["recent", "popular"] },
          users: {
            type: "object",
            required: ["items", "pagination"],
            properties: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/SearchUser" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
          projects: {
            type: "object",
            required: ["items", "pagination"],
            properties: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/SearchProject" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
          communities: {
            type: "object",
            required: ["items", "pagination"],
            properties: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/SearchCommunity" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
          posts: {
            type: "object",
            required: ["items", "pagination"],
            properties: {
              items: {
                type: "array",
                items: { $ref: "#/components/schemas/SearchPost" },
              },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
          tags: {
            type: "object",
            required: ["items", "pagination"],
            properties: {
              items: { type: "array", items: { $ref: "#/components/schemas/SearchTag" } },
              pagination: { $ref: "#/components/schemas/Pagination" },
            },
          },
          totalResults: {
            type: "integer",
            minimum: 0,
            description: "Sum of the five visible group totals.",
          },
        },
      },

      /**
       * Moderation and administration projections (Phase 11).
       *
       * Deliberately narrower than the domain schemas they resemble.
       * `ModerationUser` carries five fields and no `email`, `role`, or
       * `status`; `AdminUserSummary` carries standing *beside* the person
       * rather than inside them, so no other surface can start serving a role
       * by reusing the person projection.
       */
      ModerationUser: {
        type: "object",
        required: ["id", "username", "displayName", "avatarUrl", "builderRank"],
        properties: {
          id: stringField({ format: "uuid" }),
          username: { type: "string" },
          displayName: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          builderRank: { type: "string" },
        },
      },

      Report: {
        type: "object",
        required: [
          "id",
          "reporterId",
          "targetType",
          "targetId",
          "targetAuthorId",
          "reason",
          "details",
          "status",
          "reviewerId",
          "resolution",
          "resolvedAt",
          "createdAt",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          reporterId: stringField({ format: "uuid" }),
          targetType: {
            type: "string",
            enum: ["user", "post", "comment", "project", "community", "message"],
          },
          targetId: stringField({ format: "uuid" }),
          targetAuthorId: { type: ["string", "null"], format: "uuid" },
          reason: {
            type: "string",
            enum: [
              "spam",
              "harassment",
              "inappropriate_content",
              "impersonation",
              "other",
            ],
          },
          details: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "reviewing", "resolved", "dismissed"],
          },
          reviewerId: { type: ["string", "null"], format: "uuid" },
          resolution: { type: ["string", "null"] },
          resolvedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: stringField({ format: "date-time" }),
        },
      },

      /**
       * A report with its participants resolved.
       *
       * `targetSummary` is deliberately absent. The shipped frontend computes
       * it client-side from its own caches; producing it here would mean the
       * queue joining five content tables per page and projecting a snippet of
       * a private project or a direct message into the response.
       */
      ReportDetail: {
        allOf: [
          { $ref: "#/components/schemas/Report" },
          {
            type: "object",
            required: ["reporter", "targetAuthor"],
            properties: {
              reporter: {
                oneOf: [
                  { $ref: "#/components/schemas/ModerationUser" },
                  { type: "null" },
                ],
              },
              targetAuthor: {
                oneOf: [
                  { $ref: "#/components/schemas/ModerationUser" },
                  { type: "null" },
                ],
              },
            },
          },
        ],
      },

      ModerationAction: {
        type: "object",
        required: [
          "id",
          "moderatorId",
          "action",
          "targetType",
          "targetId",
          "targetUserId",
          "reason",
          "expiresAt",
          "reportId",
          "createdAt",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          moderatorId: { type: ["string", "null"], format: "uuid" },
          action: {
            type: "string",
            enum: [
              "warning",
              "content_removal",
              "suspension",
              "ban",
              "shadow_ban",
              "unban",
              "reinstate",
            ],
          },
          targetType: { type: "string" },
          targetId: stringField({ format: "uuid" }),
          targetUserId: { type: ["string", "null"], format: "uuid" },
          reason: { type: "string" },
          expiresAt: {
            type: ["string", "null"],
            format: "date-time",
            description: "Set for a temporary suspension; null means permanent.",
          },
          reportId: { type: ["string", "null"], format: "uuid" },
          createdAt: stringField({ format: "date-time" }),
        },
      },

      /**
       * `statusChanged` and `contentRemoved` are reported rather than assumed:
       * a removal whose target was already deleted is a successful, idempotent
       * no-op, and the caller should be able to tell.
       */
      ModerationActionResult: {
        type: "object",
        required: ["action", "statusChanged", "contentRemoved"],
        properties: {
          action: { $ref: "#/components/schemas/ModerationAction" },
          statusChanged: { type: "boolean" },
          contentRemoved: { type: "boolean" },
        },
      },

      AdminUserSummary: {
        type: "object",
        required: [
          "user",
          "role",
          "status",
          "joinedAt",
          "projectsCount",
          "followersCount",
        ],
        properties: {
          user: { $ref: "#/components/schemas/ModerationUser" },
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
          joinedAt: stringField({ format: "date-time" }),
          projectsCount: { type: "integer", minimum: 0 },
          followersCount: { type: "integer", minimum: 0 },
        },
      },

      AdminOverviewStats: {
        type: "object",
        required: [
          "totalUsers",
          "totalProjects",
          "totalCommunities",
          "pendingReportsCount",
        ],
        properties: {
          totalUsers: { type: "integer", minimum: 0 },
          totalProjects: { type: "integer", minimum: 0 },
          totalCommunities: { type: "integer", minimum: 0 },
          pendingReportsCount: { type: "integer", minimum: 0 },
        },
      },

      WeeklySignup: {
        type: "object",
        required: ["weekLabel", "count"],
        properties: {
          weekLabel: stringField({ description: 'The bucket start, e.g. "Jun 9".' }),
          count: { type: "integer", minimum: 0 },
        },
      },

      ReportsByReason: {
        type: "object",
        required: ["reason", "count"],
        properties: {
          reason: { type: "string" },
          count: { type: "integer", minimum: 0 },
        },
      },

      /**
       * One audit record. `platform_admin` only, which is why `ipAddress` and
       * `userAgent` are served at all — they are the point of an audit trail.
       * `metadata` passes through as stored; `utils/audit.ts` forbids
       * credentials from reaching it, which is where that rule belongs.
       */
      AuditLog: {
        type: "object",
        required: [
          "id",
          "actorId",
          "actor",
          "action",
          "targetType",
          "targetId",
          "metadata",
          "ipAddress",
          "userAgent",
          "createdAt",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          actorId: { type: ["string", "null"], format: "uuid" },
          actor: {
            oneOf: [
              {
                type: "object",
                required: ["id", "username", "displayName"],
                properties: {
                  id: stringField({ format: "uuid" }),
                  username: { type: "string" },
                  displayName: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          action: stringField({ description: "Free-form verb, e.g. `USER_BANNED`." }),
          targetType: { type: ["string", "null"] },
          targetId: { type: ["string", "null"], format: "uuid" },
          metadata: {
            description: "Arbitrary detail recorded with the event. Never credentials.",
          },
          ipAddress: { type: ["string", "null"] },
          userAgent: { type: ["string", "null"] },
          createdAt: stringField({ format: "date-time" }),
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

      /**
       * The shared compact user projection (`users/user.view.toUserSummary`),
       * mirroring the frontend's `PostAuthor`. Defined in Phase 5 because this
       * is the first phase to serve it — Phase 4's endpoints returned only the
       * narrower `UserPreview`. Posts, comments, and messages reuse it.
       */
      UserSummary: {
        type: "object",
        required: ["id", "username", "displayName", "avatarUrl", "builderRank"],
        properties: {
          id: stringField({ format: "uuid" }),
          username: stringField(),
          displayName: stringField(),
          avatarUrl: { type: ["string", "null"] },
          builderRank: stringField(),
        },
      },

      /* ── Phase 6: posts, comments, feed ─────────────────────────────────
         `Post.required` is exactly the 11 keys the shipped frontend's `Post`
         type declares (`src/types/post.ts`). A contract test asserts that
         equality, so this list cannot drift from the UI that consumes it.
         `visibility`, `updatedAt`, `media`, and `author` are additive and
         therefore documented but not required — and `communityId` appears
         nowhere at all. */

      CodeSnippet: {
        type: "object",
        required: ["language", "code"],
        description:
          "Reassembled from two columns on the post; a post carries at most one.",
        properties: { language: stringField(), code: stringField() },
      },

      PollOption: {
        type: "object",
        required: ["id", "label", "voteCount"],
        description: "Mirrors the frontend's `PollOption` — order is the array order.",
        properties: {
          id: stringField({ format: "uuid" }),
          label: stringField(),
          voteCount: { type: "integer", minimum: 0 },
        },
      },

      Poll: {
        type: "object",
        required: ["question", "options", "closesAt"],
        description:
          "Mirrors the frontend's `Poll`, which carries no id of its own — " +
          "voting names an option. `id`, `votedOptionId`, and `isClosed` are " +
          "additive so a reload can restore what the viewer chose.",
        properties: {
          question: stringField(),
          options: { type: "array", items: { $ref: "#/components/schemas/PollOption" } },
          closesAt: { type: ["string", "null"], format: "date-time" },
          id: stringField({ format: "uuid" }),
          votedOptionId: { type: ["string", "null"], format: "uuid" },
          isClosed: { type: "boolean" },
        },
      },

      PostMedia: {
        type: "object",
        required: ["url", "type", "position"],
        properties: {
          url: stringField({ format: "uri" }),
          type: { type: "string", enum: ["image", "video"] },
          position: { type: "integer", minimum: 0 },
          width: { type: ["integer", "null"] },
          height: { type: ["integer", "null"] },
        },
      },

      PostViewerState: {
        type: "object",
        description:
          "The caller's relationship to the post. There is deliberately no " +
          "field explaining why the post was visible.",
        required: [
          "hasLiked",
          "isBookmarked",
          "votedOptionId",
          "isAuthor",
          "canEdit",
          "canDelete",
        ],
        properties: {
          hasLiked: { type: "boolean" },
          isBookmarked: { type: "boolean" },
          votedOptionId: { type: ["string", "null"], format: "uuid" },
          isAuthor: { type: "boolean" },
          canEdit: { type: "boolean" },
          canDelete: { type: "boolean" },
        },
      },

      Post: {
        type: "object",
        description: "Mirrors the shipped frontend's `Post` and `PostWithAuthor`.",
        required: [
          "authorId",
          "codeSnippet",
          "commentsCount",
          "content",
          "createdAt",
          "id",
          "likesCount",
          "mediaUrls",
          "poll",
          "projectId",
          "type",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          authorId: stringField({ format: "uuid" }),
          projectId: { type: ["string", "null"], format: "uuid" },
          type: {
            type: "string",
            enum: [
              "text",
              "image",
              "video",
              "code",
              "markdown",
              "poll",
              "update",
              "milestone",
              "announcement",
            ],
          },
          content: stringField(),
          mediaUrls: {
            type: "array",
            items: { type: "string" },
            description: "Flattened from the media relation, ordered by position.",
          },
          codeSnippet: {
            oneOf: [{ $ref: "#/components/schemas/CodeSnippet" }, { type: "null" }],
          },
          poll: { oneOf: [{ $ref: "#/components/schemas/Poll" }, { type: "null" }] },
          likesCount: { type: "integer", minimum: 0 },
          commentsCount: {
            type: "integer",
            minimum: 0,
            description: "Includes replies; excludes soft-deleted comments.",
          },
          createdAt: stringField({ format: "date-time" }),
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          updatedAt: stringField({ format: "date-time" }),
          media: { type: "array", items: { $ref: "#/components/schemas/PostMedia" } },
          author: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      Comment: {
        type: "object",
        description:
          "Mirrors the frontend's `Comment` and `CommentWithAuthor`. A " +
          "soft-deleted comment that still has replies is returned as a " +
          "tombstone: content replaced, author null, likes zeroed.",
        required: [
          "id",
          "postId",
          "authorId",
          "parentCommentId",
          "content",
          "likesCount",
          "createdAt",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          postId: stringField({ format: "uuid" }),
          authorId: stringField(),
          parentCommentId: { type: ["string", "null"], format: "uuid" },
          content: stringField(),
          likesCount: { type: "integer", minimum: 0 },
          createdAt: stringField({ format: "date-time" }),
          updatedAt: stringField({ format: "date-time" }),
          isDeleted: { type: "boolean" },
          replyCount: { type: "integer", minimum: 0 },
          author: {
            oneOf: [{ $ref: "#/components/schemas/UserSummary" }, { type: "null" }],
          },
        },
      },

      CreatePostRequest: {
        type: "object",
        description:
          "`authorId`, `communityId`, and every counter are absent by design — " +
          "unknown keys are stripped, so posting them has no effect.",
        properties: {
          type: {
            type: "string",
            enum: [
              "text",
              "image",
              "video",
              "code",
              "markdown",
              "poll",
              "update",
              "milestone",
              "announcement",
            ],
            default: "text",
          },
          content: stringField({ maxLength: 5000 }),
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          projectId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "Optional attribution only. Naming a project never writes to it.",
          },
          mediaUrls: {
            type: "array",
            maxItems: 4,
            items: { type: "string", format: "uri" },
            description: "Must be http or https — these are rendered into the DOM.",
          },
          media: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/components/schemas/PostMedia" },
          },
          codeSnippet: { $ref: "#/components/schemas/CodeSnippet" },
          poll: {
            type: "object",
            required: ["question", "options"],
            properties: {
              question: stringField({ maxLength: 200 }),
              options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: { type: "string", maxLength: 80 },
              },
              closesAt: { type: ["string", "null"], format: "date-time" },
            },
          },
        },
      },

      UpdatePostRequest: {
        type: "object",
        description:
          "Every field optional, but an empty patch is rejected. `type` and " +
          "`poll` are absent: changing either after votes exist would " +
          "invalidate or silently reassign them.",
        properties: {
          content: stringField({ maxLength: 5000 }),
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          mediaUrls: {
            type: "array",
            maxItems: 4,
            items: { type: "string", format: "uri" },
          },
          media: {
            type: "array",
            maxItems: 4,
            items: { $ref: "#/components/schemas/PostMedia" },
          },
          codeSnippet: {
            oneOf: [{ $ref: "#/components/schemas/CodeSnippet" }, { type: "null" }],
          },
        },
      },

      CreateCommentRequest: {
        type: "object",
        required: ["content"],
        properties: {
          content: stringField({ minLength: 1, maxLength: 2000 }),
          parentCommentId: {
            type: ["string", "null"],
            format: "uuid",
            description:
              "Present for a reply. Replying to a reply is refused with a 422.",
          },
        },
      },

      /* ── Phase 5: projects ──────────────────────────────────────────────
         `Project.required` is exactly the 20 keys the shipped frontend's
         `Project` type declares (`src/types/project.ts`). A contract test
         asserts that equality, so this list cannot drift from the UI that
         consumes it. `visibility` and `owner` are additive and therefore
         documented but not required. */

      ProjectMetrics: {
        type: "object",
        required: ["views", "likes", "followers"],
        description:
          "Nested and un-suffixed because `project-metrics-bar.tsx` reads " +
          "`project.metrics.views`. The trending widget uses a flat " +
          "`likesCount` on its own type instead.",
        properties: {
          views: { type: "integer", minimum: 0 },
          likes: { type: "integer", minimum: 0 },
          followers: { type: "integer", minimum: 0 },
        },
      },

      ProjectMember: {
        type: "object",
        required: ["userId", "role", "joinedAt"],
        description:
          "The embedded member entry — userId only, no nested user. Joined " +
          "client-side by `project-service.getProjectMembers`.",
        properties: {
          userId: stringField({ format: "uuid" }),
          role: {
            type: "string",
            description:
              "The persisted role. Reads may return any of the six enum " +
              "values, including the three the shipped UI cannot label; " +
              "writes accept only owner/collaborator/contributor.",
            enum: [
              "owner",
              "admin",
              "developer",
              "designer",
              "collaborator",
              "contributor",
            ],
          },
          joinedAt: stringField({ format: "date-time" }),
        },
      },

      ProjectMemberWithUser: {
        allOf: [
          { $ref: "#/components/schemas/ProjectMember" },
          {
            type: "object",
            properties: { user: { $ref: "#/components/schemas/UserSummary" } },
          },
        ],
      },

      Milestone: {
        type: "object",
        required: ["id", "title", "description", "isComplete", "targetDate"],
        properties: {
          id: stringField({ format: "uuid" }),
          title: stringField(),
          description: stringField(),
          isComplete: { type: "boolean" },
          targetDate: { type: ["string", "null"], format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          position: { type: "integer", minimum: 0 },
        },
      },

      ProjectUpdate: {
        type: "object",
        required: ["id", "projectId", "authorId", "content", "createdAt"],
        properties: {
          id: stringField({ format: "uuid" }),
          projectId: stringField({ format: "uuid" }),
          authorId: stringField({ format: "uuid" }),
          content: stringField(),
          createdAt: stringField({ format: "date-time" }),
          updatedAt: stringField({ format: "date-time" }),
          author: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      ProjectViewerState: {
        type: "object",
        description:
          "The caller's relationship to the project. There is deliberately no " +
          "field explaining *why* access was granted.",
        required: [
          "isOwner",
          "isMember",
          "role",
          "hasLiked",
          "isFollowing",
          "canEdit",
          "canManageMembers",
        ],
        properties: {
          isOwner: { type: "boolean" },
          isMember: { type: "boolean" },
          role: { type: ["string", "null"] },
          hasLiked: { type: "boolean" },
          isFollowing: { type: "boolean" },
          canEdit: { type: "boolean" },
          canManageMembers: { type: "boolean" },
        },
      },

      TrendingProject: {
        type: "object",
        description: "Mirrors the frontend's `TrendingProjectSummary`.",
        required: [
          "id",
          "slug",
          "title",
          "description",
          "coverImageUrl",
          "techStack",
          "ownerName",
          "ownerAvatarUrl",
          "likesCount",
          "progressPercent",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          slug: stringField(),
          title: stringField(),
          description: stringField(),
          coverImageUrl: { type: ["string", "null"] },
          techStack: { type: "array", items: { type: "string" } },
          ownerName: stringField(),
          ownerAvatarUrl: { type: ["string", "null"] },
          likesCount: { type: "integer", minimum: 0 },
          progressPercent: { type: "integer", minimum: 0, maximum: 100 },
        },
      },

      Project: {
        type: "object",
        description: "Mirrors the shipped frontend's `Project` type.",
        required: [
          "coverImageUrl",
          "createdAt",
          "demoUrl",
          "description",
          "documentationUrl",
          "fundingStage",
          "gallery",
          "id",
          "members",
          "metrics",
          "milestones",
          "ownerId",
          "progressPercent",
          "repositoryUrl",
          "slug",
          "status",
          "tags",
          "techStack",
          "title",
          "updatedAt",
        ],
        properties: {
          id: stringField({ format: "uuid" }),
          slug: stringField({ pattern: "^[a-z0-9-]+$" }),
          ownerId: stringField({ format: "uuid" }),
          title: stringField(),
          description: stringField(),
          coverImageUrl: { type: ["string", "null"] },
          gallery: { type: "array", items: { type: "string" } },
          techStack: { type: "array", items: { type: "string" } },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Display names, flattened from the `Tag` relation.",
          },
          status: {
            type: "string",
            enum: ["idea", "in_progress", "beta", "launched", "archived"],
          },
          fundingStage: {
            type: "string",
            enum: ["bootstrapped", "pre_seed", "seed", "series_a_plus", "not_seeking"],
          },
          progressPercent: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Derived from milestone completion and never client-writable. " +
              "Zero milestones is 0%.",
          },
          members: {
            type: "array",
            items: { $ref: "#/components/schemas/ProjectMember" },
          },
          milestones: {
            type: "array",
            items: { $ref: "#/components/schemas/Milestone" },
          },
          demoUrl: { type: ["string", "null"] },
          repositoryUrl: { type: ["string", "null"] },
          documentationUrl: { type: ["string", "null"] },
          metrics: { $ref: "#/components/schemas/ProjectMetrics" },
          createdAt: stringField({ format: "date-time" }),
          updatedAt: stringField({ format: "date-time" }),
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          owner: { $ref: "#/components/schemas/UserSummary" },
        },
      },

      CreateProjectRequest: {
        type: "object",
        required: ["title"],
        description:
          "`slug`, `ownerId`, and every counter are absent by design — unknown " +
          "keys are stripped, so posting them has no effect.",
        properties: {
          title: stringField({ minLength: 2, maxLength: 120 }),
          description: stringField({ maxLength: 2000 }),
          techStack: { type: "array", items: { type: "string" }, maxItems: 30 },
          tags: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description:
              "Must name existing tags — this phase attaches to the taxonomy " +
              "and cannot create new tags.",
          },
          status: {
            type: "string",
            enum: ["idea", "in_progress", "beta", "launched", "archived"],
          },
          fundingStage: {
            type: "string",
            enum: ["bootstrapped", "pre_seed", "seed", "series_a_plus", "not_seeking"],
          },
          visibility: { type: "string", enum: ["public", "private", "unlisted"] },
          coverImageUrl: { type: ["string", "null"], maxLength: 500 },
          gallery: {
            type: "array",
            items: { type: "string", maxLength: 500 },
            maxItems: 20,
            description:
              "Opaque media references. Not URL-validated in this phase — the " +
              "shipped fixtures use ids like `gal_1`, and uploads land later.",
          },
          demoUrl: { type: ["string", "null"], maxLength: 500 },
          repositoryUrl: { type: ["string", "null"], maxLength: 500 },
          documentationUrl: { type: ["string", "null"], maxLength: 500 },
        },
      },

      UpdateProjectRequest: {
        allOf: [
          { $ref: "#/components/schemas/CreateProjectRequest" },
          {
            type: "object",
            required: [],
            description:
              "Every field optional, but an empty patch is rejected rather " +
              "than performed as a no-op write. `slug` cannot be changed.",
          },
        ],
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
    ...projectPaths,
    ...postPaths,
    ...communityPaths,
    ...messagePaths,
    ...notificationPaths,
    ...searchPaths,
    ...moderationPaths,
    ...adminPaths,
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
 * practical"). Handshake auth landed in Phase 3; messaging, typing, read
 * receipts, and presence in Phase 8. Notification delivery is Phase 9.
 *
 * Every `client → server` event takes an acknowledgement callback answering
 * `{ ok: true, data }` or `{ ok: false, error: { code, message } }`, using the
 * same error codes as the REST envelope — a socket frame has no status line,
 * so failures need a channel of their own.
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
  {
    event: "conversation:join",
    direction: "client → server",
    description:
      "`{ conversationId }`. Authorized against the database — a socket cannot " +
      "place itself in a room for a conversation it does not belong to. Scopes " +
      "typing indicators; 404 semantics on refusal.",
  },
  {
    event: "conversation:leave",
    direction: "client → server",
    description: "`{ conversationId }`. No authorization needed to stop listening.",
  },
  {
    event: "message:send",
    direction: "client → server",
    description:
      "`{ conversationId, content?, attachments? }`. Membership, blocking, and the " +
      "recipient's `whoCanMessage` are re-checked from the database on every frame. " +
      "Nothing is emitted until the row is persisted.",
  },
  {
    event: "message:new",
    direction: "server → client",
    description:
      "`{ message }`. Emitted to each participant's `user:{id}` room — resolved " +
      "from conversation membership, never from the sender's payload — including " +
      "the sender's own other devices. Not emitted to the conversation room, so a " +
      "client with the thread open receives exactly one copy.",
  },
  {
    event: "message:read",
    direction: "both",
    description:
      "Client sends `{ conversationId, messageId? }`; server relays " +
      "`{ conversationId, userId, lastReadAt, lastReadMessageId }`. Moves only the " +
      "authenticated user's watermark, and only forward.",
  },
  {
    event: "message:deleted",
    direction: "server → client",
    description: "`{ id, conversationId }`. The row survives; read paths skip it.",
  },
  {
    event: "message:typing",
    direction: "both",
    description:
      "`{ conversationId }` in, `{ conversationId, userId, username }` out, to the " +
      "conversation room excluding the sender. Ephemeral — never persisted. The " +
      "relayed `userId` comes from the handshake, so it cannot be spoofed.",
  },
  {
    event: "message:stop_typing",
    direction: "both",
    description: "As `message:typing`.",
  },
  {
    event: "user:online",
    direction: "server → client",
    description:
      "`{ userId, online, at }`, sent to the user's conversation partners only — " +
      "not broadcast. Fires on the first socket for that user, not on every tab.",
  },
  {
    event: "user:offline",
    direction: "server → client",
    description:
      "As `user:online`. Fires only when the user's last socket disconnects, so " +
      "closing one tab while another is open emits nothing.",
  },
  {
    event: "notification:new",
    direction: "server → client",
    description:
      "`{ notification }` — the same projection `GET /notifications` returns, " +
      "never null, and identical for every notification type including the " +
      "`project_update` fan-out. Sent to the recipient's `user:{id}` room; the " +
      "id is read off the persisted row, never from a client. Emitted only " +
      "after the row exists, and not at all when the notification was " +
      "suppressed by a block, a muted preference, or the collapse rule. The " +
      "notification socket has no inbound events: marking read is a REST call.",
  },
  {
    event: "presence:update",
    direction: "server → client",
    description:
      "`{ userId, online, at }`. Carries the same transition as the two events " +
      "above; both spellings are emitted because ARCHITECTURE §14 and TRD §19 each " +
      "name a different one.",
  },
] as const;
