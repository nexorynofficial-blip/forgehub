import type { UserRole } from "@prisma/client";

import { isModerationStaff } from "../moderation/moderation.access.js";

/**
 * Administration authorization and analytics rules, as pure functions
 * (Phase 11).
 *
 * No Prisma import, no I/O, no HTTP — the same shape as every `*.access.ts`
 * since Phase 5.
 *
 * This module deliberately **reuses** `moderation.access.ts` rather than
 * restating its rules. `canChangeRole` and `canActOnUser` live there because
 * they are the same rules whether a moderator invokes them through
 * `/moderation/actions` or an administrator invokes them through
 * `/admin/users/:id/status`; a second copy here is exactly the drift the
 * pure-predicate discipline exists to prevent. What this file adds is the
 * handful of rules that are specific to the admin surface.
 */

/* ── Capability tiers ────────────────────────────────────────────────────── */

/**
 * Who may read the administrative user table and the analytics counters.
 *
 * Moderators included: PRD §18 lists "User management" and "Analytics" as
 * administrator capabilities, and the shipped `AdminGuard` admits all three
 * staff roles to every `/admin/*` page. Reading is where they agree; writing
 * is where this file gets stricter than the frontend.
 */
export function canReadAdminSurface(role: UserRole | null): boolean {
  return isModerationStaff(role);
}

/**
 * Who may read the audit log (ruling R5).
 *
 * `platform_admin` alone. The audit trail records every login, password
 * change, IP address, and user agent on the platform — it is the single most
 * sensitive read surface in the API, and TRD §29's *"Audit logs must not be
 * editable by normal users"* sets a floor rather than a ceiling. A moderator
 * reviewing reports has no need for the login history of the people they
 * moderate, so they do not get it.
 *
 * Written as its own predicate rather than an inline role comparison so the
 * unit tests can pin every role against it, including the two staff roles that
 * are refused.
 */
export function canReadAuditLogs(role: UserRole | null): boolean {
  return role === "platform_admin";
}

/* ── Status changes ──────────────────────────────────────────────────────── */

/*
 * The state-to-verb translation a status change needs
 * (`actionForStatusChange`) lives in `moderation.access.ts`, not here.
 *
 * It is a moderation rule — it decides which `ModerationActionType` gets
 * recorded — and putting it here would point the dependency arrow the wrong
 * way: admin depends on moderation, never the reverse. `admin.service.ts`
 * delegates the whole status change to `moderation.service.applyStatusChange`
 * for the same reason, so there is exactly one code path that writes
 * `User.status` and it is the one that also writes the audit row.
 */

/* ── Analytics windows ───────────────────────────────────────────────────── */

/** How many weekly buckets the signups chart plots. Matches the shipped UI. */
export const SIGNUP_WEEKS = 8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface WeekBucket {
  /** Inclusive start of the week, at UTC midnight. */
  start: Date;
  /** Exclusive end — the next bucket's start. */
  end: Date;
  /** `"Jun 9"`, the format the shipped chart renders on its axis. */
  weekLabel: string;
}

/**
 * The label format the frontend's `mockWeeklySignups` uses.
 *
 * Pinned to `en-US` and UTC rather than the server's locale and zone, so the
 * same instant produces the same label on every machine that runs the tests.
 */
const LABEL_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function utcMidnight(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

/**
 * The `SIGNUP_WEEKS` buckets ending with the week containing `now`, oldest
 * first.
 *
 * Pure, and takes `now` as an argument rather than reading the clock, so the
 * unit tests can pin the boundaries exactly. Buckets are half-open
 * (`start <= t < end`) and aligned to UTC midnight, which means a signup is
 * counted in exactly one bucket regardless of the server's timezone — the
 * alternative, local-midnight boundaries, would silently move every count when
 * the deployment region changed.
 */
export function signupWeekBuckets(now: Date, weeks = SIGNUP_WEEKS): WeekBucket[] {
  const today = utcMidnight(now);
  // The current week's bucket ends tomorrow, so today's signups are included.
  const finalEnd = new Date(today.getTime() + MS_PER_DAY);

  const buckets: WeekBucket[] = [];

  for (let index = weeks - 1; index >= 0; index -= 1) {
    const end = new Date(finalEnd.getTime() - index * MS_PER_WEEK);
    const start = new Date(end.getTime() - MS_PER_WEEK);
    buckets.push({ start, end, weekLabel: LABEL_FORMAT.format(start) });
  }

  return buckets;
}
