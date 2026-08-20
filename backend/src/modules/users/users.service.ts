import { Prisma } from "@prisma/client";

import { AuditAction, recordAuditEvent, type AuditContext } from "../../utils/audit.js";
import { AppError } from "../../utils/errors.js";
import * as follows from "../follows/follows.repository.js";
import * as repo from "./users.repository.js";
import {
  completionFromRow,
  toCurrentUserView,
  toRedactedUserView,
  toUserView,
} from "./user.view.js";
import { canSeeEmail, resolveVisibility } from "./visibility.js";
import type {
  UpdateNotificationPreferenceInput,
  UpdateProfileInput,
  UpdateSettingsInput,
} from "./users.schema.js";
import type {
  CurrentUserView,
  NotificationPreferencesView,
  PrivacySettingsView,
  ProfileResponse,
  RelationshipView,
} from "./users.types.js";

/**
 * Users and profiles business logic (BACKEND_ARCHITECTURE.md §17–18).
 *
 * Owns every authorization and privacy decision; touches Prisma only through
 * the repositories. Two rules recur throughout:
 *
 *   1. **Identity comes from the caller, never the payload.** Every mutating
 *      method takes an `actorId` resolved from the verified access token.
 *      There is no code path where a body field selects whose profile is
 *      written.
 *   2. **Privacy is decided once, in `visibility.ts`, and applied once, in
 *      `user.view.ts`.** Nothing here hand-assembles a response.
 */

/** Viewer context, assembled by the controller from `req.user`. */
export interface Viewer {
  id: string | null;
  role: import("@prisma/client").UserRole | null;
}

export const ANONYMOUS: Viewer = { id: null, role: null };

/* ── Reads ──────────────────────────────────────────────────────────────── */

export async function getCurrentUser(userId: string): Promise<CurrentUserView> {
  const row = await repo.findById(userId);

  if (!row) {
    // The token verified but the account is gone — treat as a dead session
    // rather than a 404, because the caller's credential is what is stale.
    throw AppError.authentication("Session is no longer valid");
  }

  return toCurrentUserView(row);
}

export interface ProfileLookupResult {
  profile: ProfileResponse;
  /** Null for anonymous viewers — there is no relationship to describe. */
  relationship: RelationshipView | null;
}

/**
 * Public profile lookup.
 *
 * The 404 on a block is deliberate and load-bearing (decision J4): a 403
 * would confirm the account exists and announce the block, while a 404 is
 * indistinguishable from a deleted or never-existing account. That is the
 * behaviour a blocked user should see.
 */
export async function getProfileByUsername(
  username: string,
  viewer: Viewer,
): Promise<ProfileLookupResult> {
  const row = await repo.findByUsername(username);

  if (!row) {
    throw AppError.notFound("User not found");
  }

  const relationship =
    viewer.id !== null && viewer.id !== row.id
      ? await follows.findRelationship(viewer.id, row.id)
      : null;

  const decision = resolveVisibility({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    targetId: row.id,
    targetVisibility: row.profile?.visibility ?? "public",
    isFollowing: relationship?.isFollowing ?? false,
    targetBlockedViewer: relationship?.isBlockedBy ?? false,
  });

  if (decision === "not_found") {
    throw AppError.notFound("User not found");
  }

  const relationshipView: RelationshipView | null =
    viewer.id === null
      ? null
      : {
          isSelf: viewer.id === row.id,
          isFollowing: relationship?.isFollowing ?? false,
          isFollowedBy: relationship?.isFollowedBy ?? false,
          // `isBlockedBy` is intentionally not surfaced.
          isBlocking: relationship?.isBlocking ?? false,
        };

  if (decision === "redacted") {
    return { profile: toRedactedUserView(row), relationship: relationshipView };
  }

  const includeEmail = canSeeEmail({
    viewerId: viewer.id,
    viewerRole: viewer.role,
    targetId: row.id,
    showEmailOnProfile: row.settings?.showEmailOnProfile ?? false,
  });

  return { profile: toUserView(row, includeEmail), relationship: relationshipView };
}

/**
 * Achievements for a profile. Read-only in Phase 4 — the awarding engine is
 * Phase 10. Reuses the same visibility gate so a followers-only profile does
 * not leak its achievements through a side door.
 */
export async function getAchievements(username: string, viewer: Viewer) {
  const result = await getProfileByUsername(username, viewer);

  if ("restricted" in result.profile) {
    throw AppError.authorization("This profile is not visible to you");
  }

  return {
    achievements: result.profile.achievements,
    badges: result.profile.badges,
  };
}

/* ── Profile updates ────────────────────────────────────────────────────── */

/**
 * Applies the Settings → Account payload to the caller's own profile.
 *
 * `userId` is always the authenticated caller. There is deliberately no
 * "update user X" variant — an admin editing someone else's profile is a
 * Phase 11 concern with its own audit requirements.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
  context: AuditContext,
): Promise<CurrentUserView> {
  const current = await repo.findById(userId);

  if (!current) {
    throw AppError.authentication("Session is no longer valid");
  }

  // The shipped form posts `email` alongside the profile fields. Changing it
  // is a credential operation that needs re-verification, so rather than
  // silently discarding a field the client believes it saved, an actual
  // change is refused explicitly.
  if (input.email !== undefined && input.email !== current.email) {
    throw AppError.validation("Email changes require verification", [
      {
        field: "email",
        message:
          "Changing your email address is not supported yet — it requires re-verification.",
      },
    ]);
  }

  if (input.username !== undefined && input.username !== current.username) {
    await changeUsername(userId, current.username, input.username, context);
  }

  const profileInput: repo.ProfileUpdateInput = {};
  if (input.displayName !== undefined) profileInput.displayName = input.displayName;
  if (input.bio !== undefined) profileInput.bio = input.bio;
  if (input.location !== undefined) profileInput.location = input.location;
  if (input.websiteUrl !== undefined) profileInput.websiteUrl = input.websiteUrl;
  if (input.skills !== undefined) profileInput.skills = input.skills;
  if (input.techStack !== undefined) profileInput.techStack = input.techStack;
  if (input.experienceYears !== undefined) {
    profileInput.experienceYears = input.experienceYears;
  }
  if (input.socialLinks !== undefined) profileInput.socialLinks = input.socialLinks;

  // Completion is derived from the post-update state, so it is computed by
  // merging the patch over the current row rather than from either alone.
  const completion = completionFromRow({
    ...current,
    profile: current.profile
      ? {
          ...current.profile,
          bio: input.bio ?? current.profile.bio,
          location: input.location ?? current.profile.location,
          websiteUrl: input.websiteUrl ?? current.profile.websiteUrl,
          skills: input.skills ?? current.profile.skills,
          techStack: input.techStack ?? current.profile.techStack,
          experienceYears:
            input.experienceYears !== undefined
              ? input.experienceYears
              : current.profile.experienceYears,
          socialLinks: input.socialLinks ?? current.profile.socialLinks,
        }
      : null,
  });

  const updated = await repo.updateProfile(userId, profileInput, completion);
  return toCurrentUserView(updated);
}

/**
 * Changes a handle, treating the unique index as the real guarantee.
 *
 * The pre-check produces a clean 409 for the common case; the `P2002` catch
 * covers the race where someone claims the name between the check and the
 * write. Without the catch, that race would surface as a 500.
 */
async function changeUsername(
  userId: string,
  previous: string,
  next: string,
  context: AuditContext,
): Promise<void> {
  if (await repo.usernameTaken(next, userId)) {
    throw AppError.conflict("That username is already taken");
  }

  try {
    await repo.updateUsername(userId, next);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw AppError.conflict("That username is already taken");
    }
    throw error;
  }

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.USERNAME_CHANGED,
    targetType: "user",
    targetId: userId,
    metadata: { from: previous, to: next },
  });
}

export async function updateUsername(
  userId: string,
  username: string,
  context: AuditContext,
): Promise<{ username: string }> {
  const current = await repo.findById(userId);

  if (!current) {
    throw AppError.authentication("Session is no longer valid");
  }

  if (current.username === username) {
    return { username };
  }

  await changeUsername(userId, current.username, username, context);
  return { username };
}

/* ── Settings ───────────────────────────────────────────────────────────── */

export async function getSettings(userId: string): Promise<PrivacySettingsView> {
  const row = await repo.findSettings(userId);

  if (!row) {
    throw AppError.authentication("Session is no longer valid");
  }

  return {
    profileVisibility: row.profileVisibility,
    showEmailOnProfile: row.showEmailOnProfile,
    whoCanMessage: row.whoCanMessage,
    twoFactorEnabled: row.twoFactorEnabled,
  };
}

export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
  context: AuditContext,
): Promise<PrivacySettingsView> {
  await repo.updateSettings(userId, input);

  await recordAuditEvent({
    ...context,
    actorId: userId,
    action: AuditAction.PRIVACY_SETTINGS_UPDATED,
    targetType: "user",
    targetId: userId,
    // Setting *names* only — values describe the user's privacy posture.
    metadata: { fields: Object.keys(input) },
  });

  return getSettings(userId);
}

/* ── Notification preferences ───────────────────────────────────────────── */

/**
 * Returns a complete matrix, not just the stored rows.
 *
 * Registration seeds one row per type, but a type added to the enum later
 * would have no row for existing users — and the Settings screen renders a
 * fixed grid. Filling gaps with the schema defaults keeps the UI from showing
 * blank toggles for a preference that has simply never been set.
 */
export async function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferencesView> {
  const rows = await repo.findNotificationPreferences(userId);
  const stored = new Map(rows.map((row) => [row.type, row]));

  const matrix: NotificationPreferencesView = {};
  for (const type of repo.allNotificationTypes()) {
    const row = stored.get(type);
    matrix[type] = { inApp: row?.inApp ?? true, email: row?.email ?? false };
  }

  return matrix;
}

export async function updateNotificationPreference(
  userId: string,
  input: UpdateNotificationPreferenceInput,
): Promise<NotificationPreferencesView> {
  const patch: { inApp?: boolean; email?: boolean } = {};
  if (input.inApp !== undefined) patch.inApp = input.inApp;
  if (input.email !== undefined) patch.email = input.email;

  await repo.upsertNotificationPreference(userId, input.type, patch);
  return getNotificationPreferences(userId);
}
