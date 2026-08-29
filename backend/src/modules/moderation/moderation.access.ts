import type {
  EntityType,
  ModerationActionType,
  ModerationStatus,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  UserRole,
} from "@prisma/client";

/**
 * Moderation authorization and lifecycle rules, as pure functions (Phase 11).
 *
 * No Prisma import, no I/O, no HTTP — the same shape as `project.access.ts`,
 * `community.access.ts`, `notification.access.ts`, and `search.access.ts`.
 * Everything a moderator is or is not allowed to do is decided here, and
 * `tests/moderation-unit.test.ts` pins each rule without a database.
 *
 * Four rules govern this file, and each exists because getting it wrong is a
 * privilege-escalation bug rather than a cosmetic one:
 *
 *   1. **Rank decides who may act on whom.** A moderator may not action a peer
 *      or a superior. Without this, the moderator role is effectively the
 *      platform-admin role with extra steps.
 *   2. **Nobody moderates themselves.** Self-ban, self-suspension, and
 *      self-role-change are all refused, whatever the actor's rank.
 *   3. **Role changes are platform-admin only**, and `platform_admin` is only
 *      grantable by someone who already holds it.
 *   4. **The report lifecycle is a state machine**, not a free `status` write.
 *      A caller cannot jump a report from `pending` straight to `resolved`.
 */

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

/**
 * Every report target the PRD and schema require.
 *
 * Six, including `message`. The frontend's `types/admin.ts` declares only
 * five — it omits `message` — but BACKEND_PRD.md §17 lists "Messages" among
 * the things users must be able to report, and `ReportTargetType` in the
 * schema carries the member. The specification governs the backend contract;
 * a mock type narrower than the schema is not a reason to drop a capability.
 */
export const REPORT_TARGET_TYPES = [
  "user",
  "post",
  "comment",
  "project",
  "community",
  "message",
] as const satisfies readonly ReportTargetType[];

export const REPORT_REASONS = [
  "spam",
  "harassment",
  "inappropriate_content",
  "impersonation",
  "other",
] as const satisfies readonly ReportReason[];

/**
 * The four lifecycle states.
 *
 * `reviewing` is retained deliberately. The frontend's `ReportStatus` union
 * has three members and no `reviewing`, but the schema has four and the queue
 * needs the middle one: without it there is no way for a moderator to claim a
 * report, and two moderators would silently work the same row. The frontend
 * filters client-side and is unharmed by a state it does not name.
 */
export const REPORT_STATUSES = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const satisfies readonly ReportStatus[];

/**
 * The seven action verbs the schema already carries.
 *
 * Four are named by BACKEND_ARCHITECTURE.md §25 — warning, content removal,
 * temporary suspension, permanent ban. The other three (`shadow_ban`,
 * `unban`, `reinstate`) exist in `ModerationActionType` and are supported
 * because the enum and the shipped admin UI both expect them. No verb is
 * invented here; this list is exactly the enum.
 */
export const MODERATION_ACTION_TYPES = [
  "warning",
  "content_removal",
  "suspension",
  "ban",
  "shadow_ban",
  "unban",
  "reinstate",
] as const satisfies readonly ModerationActionType[];

/* ── Role rank ───────────────────────────────────────────────────────────── */

/**
 * A total order over roles, used only to answer "may A act on B?".
 *
 * Deliberately *not* exported as a general permission mechanism. Phases 4–10
 * ask `isAdminRole(role)` — a boolean — and that stays the question everywhere
 * else. Rank exists because moderation is the first surface where one
 * privileged user acts on another and the answer cannot be a boolean.
 *
 * `guest` is the frontend's "not signed in" sentinel and is never written to
 * the database (`auth.repository.createUser`); it ranks below everything so no
 * arithmetic here can accidentally authorize it.
 */
const ROLE_RANK: Record<UserRole, number> = {
  guest: 0,
  member: 1,
  verified_builder: 2,
  moderator: 3,
  community_admin: 4,
  platform_admin: 5,
};

export function roleRank(role: UserRole): number {
  return ROLE_RANK[role];
}

/** Mirrors `role.middleware.isAdminRole`; `guest` is never authorized. */
export function isModerationStaff(role: UserRole | null): boolean {
  if (role === null || role === "guest") return false;
  return role === "moderator" || role === "community_admin" || role === "platform_admin";
}

/* ── Who may act on whom ─────────────────────────────────────────────────── */

export interface ActorTargetContext {
  actorId: string;
  actorRole: UserRole;
  targetUserId: string;
  targetUserRole: UserRole;
}

export type ActionRefusal = "not_staff" | "self" | "target_outranks_actor";

export type ActionDecision =
  { allowed: true } | { allowed: false; reason: ActionRefusal };

/**
 * Whether one user may take a moderation action against another.
 *
 * Order matters and each branch is a deliberate choice:
 *
 *   1. **Staff only.** An ordinary member reaching this function at all would
 *      mean the route guard failed; it is re-asserted rather than assumed.
 *   2. **Never yourself.** A moderator cannot ban, suspend, shadow-ban, warn,
 *      unban, or reinstate their own account. There is no legitimate use and
 *      the failure mode — an admin lifting their own ban — is severe.
 *   3. **Strictly greater rank.** A moderator may action members and verified
 *      builders. A moderator may **not** action another moderator, a community
 *      admin, or a platform admin; a community admin may not action a platform
 *      admin; and no platform admin may action another platform admin. The
 *      last case is the one worth stating plainly: peers cannot depose peers,
 *      so removing a platform admin is a deliberate out-of-band operation
 *      rather than something one compromised account can do to the others.
 */
export function canActOnUser(context: ActorTargetContext): ActionDecision {
  if (!isModerationStaff(context.actorRole)) {
    return { allowed: false, reason: "not_staff" };
  }
  if (context.actorId === context.targetUserId) {
    return { allowed: false, reason: "self" };
  }
  if (roleRank(context.actorRole) <= roleRank(context.targetUserRole)) {
    return { allowed: false, reason: "target_outranks_actor" };
  }
  return { allowed: true };
}

/* ── Role changes (ruling R4) ────────────────────────────────────────────── */

export interface RoleChangeContext {
  actorId: string;
  actorRole: UserRole;
  targetUserId: string;
  targetUserRole: UserRole;
  nextRole: UserRole;
}

export type RoleChangeRefusal =
  "not_platform_admin" | "self" | "target_outranks_actor" | "cannot_assign_guest";

export type RoleChangeDecision =
  { allowed: true } | { allowed: false; reason: RoleChangeRefusal };

/**
 * Whether a role change is permitted.
 *
 * Stricter than `canActOnUser` on every axis, because a role change is the
 * only moderation operation that hands out authority rather than taking it
 * away:
 *
 *   - **`platform_admin` only.** A moderator or community admin cannot change
 *     anyone's role at all, so neither can promote anyone — which is the
 *     escalation path this rule closes.
 *   - **Never your own role.** Otherwise the rank check is trivially defeated
 *     by promoting yourself first.
 *   - **`guest` is never assignable.** It is the frontend's not-signed-in
 *     sentinel, not a real role, and writing it to a row would produce an
 *     account that fails every authorization check in confusing ways.
 *
 * Granting `platform_admin` needs no branch of its own: the first rule already
 * makes `platform_admin` the *only* role that can grant anything, so a
 * moderator or community admin cannot reach the grant at all. That is the
 * escalation the ruling names, and it is closed by the first `if` rather than
 * by a second one that could never fire.
 */
export function canChangeRole(context: RoleChangeContext): RoleChangeDecision {
  if (context.actorRole !== "platform_admin") {
    return { allowed: false, reason: "not_platform_admin" };
  }
  if (context.actorId === context.targetUserId) {
    return { allowed: false, reason: "self" };
  }
  if (context.nextRole === "guest") {
    return { allowed: false, reason: "cannot_assign_guest" };
  }
  if (roleRank(context.actorRole) <= roleRank(context.targetUserRole)) {
    return { allowed: false, reason: "target_outranks_actor" };
  }
  return { allowed: true };
}

/* ── Report lifecycle ────────────────────────────────────────────────────── */

/**
 * The legal transitions, and nothing else.
 *
 *     pending ──► reviewing ──► resolved
 *                          └──► dismissed
 *
 * `resolved` and `dismissed` are terminal: a closed report is a historical
 * record, and reopening it would let a reviewer rewrite the outcome after the
 * fact. A transition to the state a report is already in is refused rather
 * than treated as a no-op, so a double-submitted form is visible as a 409
 * instead of silently overwriting `reviewerId` and `resolvedAt`.
 *
 * Note there is no `pending → resolved` shortcut. A report must be claimed
 * before it can be closed, which is what makes `reviewerId` meaningful.
 */
const REPORT_TRANSITIONS: Record<ReportStatus, readonly ReportStatus[]> = {
  pending: ["reviewing"],
  reviewing: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

export function canTransitionReport(from: ReportStatus, to: ReportStatus): boolean {
  return REPORT_TRANSITIONS[from].includes(to);
}

export function isTerminalReportStatus(status: ReportStatus): boolean {
  return REPORT_TRANSITIONS[status].length === 0;
}

/** Whether a status closes the report and therefore stamps `resolvedAt`. */
export function closesReport(status: ReportStatus): boolean {
  return status === "resolved" || status === "dismissed";
}

/* ── Action semantics ────────────────────────────────────────────────────── */

/**
 * The moderation status an action leaves the target user in.
 *
 * `null` means "leave the status alone" — a warning and a content removal are
 * both real, recorded actions that do not change the account's standing.
 *
 * The mapping of *suspension* onto `banned` deserves stating, because it is
 * the schema's design rather than a choice made here. `ModerationStatus` has
 * three members and none of them is `suspended`; `ModerationAction.expiresAt`
 * is documented in the schema as *"Set for temporary suspensions; null means
 * permanent."* So the pair `(status = banned, expiresAt = <future>)` **is** a
 * temporary suspension and `(status = banned, expiresAt = null)` is a
 * permanent ban. Both stop the account from authenticating; only the first
 * lapses on its own (see `isSuspensionExpired`).
 */
export function statusAfterAction(action: ModerationActionType): ModerationStatus | null {
  switch (action) {
    case "warning":
    case "content_removal":
      return null;
    case "suspension":
    case "ban":
      return "banned";
    case "shadow_ban":
      return "shadow_banned";
    case "unban":
    case "reinstate":
      return "active";
  }
}

/**
 * The moderation verb that expresses a requested status change.
 *
 * `PATCH /admin/users/:id/status` takes a *state* (`active`, `banned`,
 * `shadow_banned`) because that is what the shipped admin UI sends —
 * `updateUserStatus(userId, status)`. Moderation records *verbs*. This is the
 * translation, and it is what lets the admin route reuse this module's
 * transactional write instead of having a second path that changes
 * `User.status` without producing a `ModerationAction` and an `AuditLog`.
 *
 * Returns `null` when the requested state is the one the account already
 * holds. The service turns that into a 409 rather than recording an action
 * that changed nothing.
 *
 * Restoring to `active` has two verbs and which applies depends on what is
 * being undone: `unban` lifts a ban or a suspension, `reinstate` lifts a
 * shadow ban. Both are members of `ModerationActionType`; neither is invented
 * here. The pairing is an inference from the enum rather than something any
 * specification states, and it is flagged as such in `docs/MODERATION.md`.
 */
export function actionForStatusChange(
  current: ModerationStatus,
  next: ModerationStatus,
): ModerationActionType | null {
  if (current === next) return null;

  switch (next) {
    case "banned":
      return "ban";
    case "shadow_banned":
      return "shadow_ban";
    case "active":
      return current === "shadow_banned" ? "reinstate" : "unban";
  }
}

/** Only a temporary suspension carries an expiry; every other verb forbids one. */
export function requiresExpiry(action: ModerationActionType): boolean {
  return action === "suspension";
}

export function allowsExpiry(action: ModerationActionType): boolean {
  return requiresExpiry(action);
}

/** Whether the action removes content rather than acting on an account. */
export function targetsContent(action: ModerationActionType): boolean {
  return action === "content_removal";
}

/**
 * Whether the affected user is told about the action (ruling R11).
 *
 * A warning is pointless if unseen, and being suspended, banned, or having
 * content removed are all things a person needs to know happened. The two
 * exceptions are deliberate:
 *
 *   - **`shadow_ban`** notifies nobody. Announcing a shadow ban would defeat
 *     the only property that distinguishes it from a ban.
 *   - **`unban` and `reinstate`** are restorations; the account works again,
 *     which the user discovers by using it. Nothing here forbids notifying
 *     them later, but no specification asks for it.
 */
export function notifiesTarget(action: ModerationActionType): boolean {
  return (
    action === "warning" ||
    action === "suspension" ||
    action === "ban" ||
    action === "content_removal"
  );
}

/* ── Lazy suspension expiry (ruling R12) ─────────────────────────────────── */

/**
 * Whether a recorded suspension has lapsed.
 *
 * `null` is a permanent ban and never expires. Everything else is compared
 * against a caller-supplied `now` rather than reading the clock here, so the
 * rule stays pure and the tests can pin both sides of the boundary.
 *
 * The comparison is `<=`: a suspension that expires exactly now is over.
 */
export function isSuspensionExpired(expiresAt: Date | null, now: Date): boolean {
  if (expiresAt === null) return false;
  return expiresAt.getTime() <= now.getTime();
}

/* ── Target mapping ──────────────────────────────────────────────────────── */

/**
 * The `EntityType` members a report can name.
 *
 * Narrower than `EntityType` itself, which also carries `conversation` and
 * `achievement` — neither of which is reportable. Stating the narrowing in the
 * type rather than leaving it implicit is what lets a report target be handed
 * straight to `notification.port.ts`, whose `PortEntityType` is narrow for its
 * own reasons: the compiler checks the two agree instead of a cast papering
 * over the difference.
 */
export type ReportEntityType = Extract<
  EntityType,
  "user" | "post" | "comment" | "project" | "community" | "message"
>;

/**
 * A report's target type as the `EntityType` that `ModerationAction`,
 * `AuditLog`, and `Notification` all key on.
 *
 * Every `ReportTargetType` member has an identically-named `EntityType`
 * member, so this is a widening rather than a translation — written out as an
 * exhaustive switch anyway so that adding a report target without a matching
 * entity type fails to compile instead of failing at runtime.
 */
export function entityTypeForReportTarget(target: ReportTargetType): ReportEntityType {
  switch (target) {
    case "user":
      return "user";
    case "post":
      return "post";
    case "comment":
      return "comment";
    case "project":
      return "project";
    case "community":
      return "community";
    case "message":
      return "message";
  }
}

/**
 * Whether a viewer may read the moderation queue.
 *
 * Identical to `isModerationStaff` today, and separate from it on purpose: the
 * queue is a read surface and the actions are a write surface, and a later
 * phase narrowing one should not silently narrow the other.
 */
export function canReadModerationQueue(role: UserRole | null): boolean {
  return isModerationStaff(role);
}

/**
 * Whether a viewer may read a single report.
 *
 * Staff may read any report. A reporter may **not** read their own report back
 * — deliberately. A report carries `targetAuthorId`, the reviewer's identity,
 * and a free-text resolution, none of which is the reporter's business, and
 * letting the filer poll the outcome would turn the queue into a channel for
 * confirming that a given account exists and is under review.
 */
export function canReadReport(role: UserRole | null): boolean {
  return isModerationStaff(role);
}
