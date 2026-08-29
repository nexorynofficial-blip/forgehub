import type { ModerationActionType, ReportStatus, UserRole } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  MODERATION_ACTION_TYPES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  actionForStatusChange,
  allowsExpiry,
  canActOnUser,
  canChangeRole,
  canReadModerationQueue,
  canReadReport,
  canTransitionReport,
  closesReport,
  entityTypeForReportTarget,
  isModerationStaff,
  isSuspensionExpired,
  isTerminalReportStatus,
  notifiesTarget,
  requiresExpiry,
  roleRank,
  statusAfterAction,
  targetsContent,
} from "../src/modules/moderation/moderation.access.js";
import {
  SIGNUP_WEEKS,
  canReadAdminSurface,
  canReadAuditLogs,
  signupWeekBuckets,
} from "../src/modules/admin/admin.access.js";
import {
  isUnsuppressible,
  resolveDelivery,
} from "../src/modules/notifications/notification.access.js";

/**
 * The Phase 11 authorization and lifecycle rules (PRD §17–18, TRD §28,
 * ARCHITECTURE §25).
 *
 * These functions decide whether one user may change another's standing,
 * remove their content, or read the platform's audit trail. Getting one wrong
 * is a privilege-escalation bug, so they are tested **exhaustively** — every
 * role against every role, every action verb, every lifecycle transition —
 * rather than by example.
 *
 * Pure, so no database, no mocks, no server.
 */

const ROLES: UserRole[] = [
  "guest",
  "member",
  "verified_builder",
  "moderator",
  "community_admin",
  "platform_admin",
];

const STAFF: UserRole[] = ["moderator", "community_admin", "platform_admin"];
const NON_STAFF: UserRole[] = ["guest", "member", "verified_builder"];

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

describe("the moderation vocabulary", () => {
  it("supports every report target the PRD names, including message", () => {
    expect([...REPORT_TARGET_TYPES]).toEqual([
      "user",
      "post",
      "comment",
      "project",
      "community",
      "message",
    ]);
    // PRD §17 lists Messages as reportable; the shipped frontend type omits
    // it. The specification governs the backend, so the member stays.
    expect(REPORT_TARGET_TYPES).toContain("message");
  });

  it("retains the reviewing state the frontend union omits", () => {
    expect([...REPORT_STATUSES]).toEqual([
      "pending",
      "reviewing",
      "resolved",
      "dismissed",
    ]);
    expect(REPORT_STATUSES).toContain("reviewing");
  });

  it("carries the five report reasons and no more", () => {
    expect([...REPORT_REASONS]).toEqual([
      "spam",
      "harassment",
      "inappropriate_content",
      "impersonation",
      "other",
    ]);
  });

  it("carries exactly the seven schema action verbs, inventing none", () => {
    expect([...MODERATION_ACTION_TYPES]).toEqual([
      "warning",
      "content_removal",
      "suspension",
      "ban",
      "shadow_ban",
      "unban",
      "reinstate",
    ]);
  });

  it("maps every report target onto a matching entity type", () => {
    for (const target of REPORT_TARGET_TYPES) {
      expect(entityTypeForReportTarget(target)).toBe(target);
    }
  });
});

/* ── Role rank ───────────────────────────────────────────────────────────── */

describe("roleRank", () => {
  it("orders the six roles strictly", () => {
    const ranks = ROLES.map(roleRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ROLES.length);
  });

  it("puts guest below everything", () => {
    for (const role of ROLES.filter((r) => r !== "guest")) {
      expect(roleRank("guest")).toBeLessThan(roleRank(role));
    }
  });
});

describe("isModerationStaff", () => {
  it.each(STAFF)("admits %s", (role) => {
    expect(isModerationStaff(role)).toBe(true);
  });

  it.each(NON_STAFF)("refuses %s", (role) => {
    expect(isModerationStaff(role)).toBe(false);
  });

  it("refuses a null role", () => {
    expect(isModerationStaff(null)).toBe(false);
  });

  it("gates the queue and single-report reads identically", () => {
    for (const role of [...ROLES, null]) {
      expect(canReadModerationQueue(role)).toBe(isModerationStaff(role));
      expect(canReadReport(role)).toBe(isModerationStaff(role));
    }
  });
});

/* ── canActOnUser: the full matrix ───────────────────────────────────────── */

describe("canActOnUser", () => {
  const ACTOR = "actor-id";
  const TARGET = "target-id";

  function decide(actorRole: UserRole, targetUserRole: UserRole) {
    return canActOnUser({
      actorId: ACTOR,
      actorRole,
      targetUserId: TARGET,
      targetUserRole,
    });
  }

  it("refuses every non-staff actor against every target", () => {
    for (const actorRole of NON_STAFF) {
      for (const targetRole of ROLES) {
        expect(decide(actorRole, targetRole)).toEqual({
          allowed: false,
          reason: "not_staff",
        });
      }
    }
  });

  it("refuses self-action for every staff role", () => {
    for (const role of STAFF) {
      const decision = canActOnUser({
        actorId: ACTOR,
        actorRole: role,
        targetUserId: ACTOR,
        targetUserRole: role,
      });
      expect(decision).toEqual({ allowed: false, reason: "self" });
    }
  });

  it("allows a staff actor only against a strictly lower rank", () => {
    for (const actorRole of STAFF) {
      for (const targetRole of ROLES) {
        const expected = roleRank(actorRole) > roleRank(targetRole);
        expect(decide(actorRole, targetRole).allowed).toBe(expected);
      }
    }
  });

  it("refuses a moderator against another moderator", () => {
    expect(decide("moderator", "moderator")).toEqual({
      allowed: false,
      reason: "target_outranks_actor",
    });
  });

  it("refuses a moderator against a community admin and a platform admin", () => {
    expect(decide("moderator", "community_admin").allowed).toBe(false);
    expect(decide("moderator", "platform_admin").allowed).toBe(false);
  });

  it("refuses a community admin against a platform admin", () => {
    expect(decide("community_admin", "platform_admin").allowed).toBe(false);
  });

  it("refuses a platform admin against another platform admin", () => {
    // Peers cannot depose peers: removing a platform admin is deliberately an
    // out-of-band operation rather than something one compromised account can
    // do to the others.
    expect(decide("platform_admin", "platform_admin")).toEqual({
      allowed: false,
      reason: "target_outranks_actor",
    });
  });

  it("allows a moderator against a member and a verified builder", () => {
    expect(decide("moderator", "member").allowed).toBe(true);
    expect(decide("moderator", "verified_builder").allowed).toBe(true);
  });
});

/* ── canChangeRole: ruling R4 ────────────────────────────────────────────── */

describe("canChangeRole", () => {
  const ACTOR = "actor-id";
  const TARGET = "target-id";

  function decide(actorRole: UserRole, targetUserRole: UserRole, nextRole: UserRole) {
    return canChangeRole({
      actorId: ACTOR,
      actorRole,
      targetUserId: TARGET,
      targetUserRole,
      nextRole,
    });
  }

  it("refuses every role except platform_admin, whatever the grant", () => {
    for (const actorRole of ROLES.filter((r) => r !== "platform_admin")) {
      for (const nextRole of ROLES) {
        expect(decide(actorRole, "member", nextRole)).toEqual({
          allowed: false,
          reason: "not_platform_admin",
        });
      }
    }
  });

  it("refuses a moderator promoting anyone to platform_admin", () => {
    expect(decide("moderator", "member", "platform_admin").allowed).toBe(false);
  });

  it("refuses a community admin promoting anyone to platform_admin", () => {
    expect(decide("community_admin", "member", "platform_admin").allowed).toBe(false);
  });

  it("refuses a self-role-change even for a platform admin", () => {
    expect(
      canChangeRole({
        actorId: ACTOR,
        actorRole: "platform_admin",
        targetUserId: ACTOR,
        targetUserRole: "platform_admin",
        nextRole: "member",
      }),
    ).toEqual({ allowed: false, reason: "self" });
  });

  it("refuses assigning guest, the not-signed-in sentinel", () => {
    expect(decide("platform_admin", "member", "guest")).toEqual({
      allowed: false,
      reason: "cannot_assign_guest",
    });
  });

  it("refuses a platform admin acting on another platform admin", () => {
    expect(decide("platform_admin", "platform_admin", "member")).toEqual({
      allowed: false,
      reason: "target_outranks_actor",
    });
  });

  it("allows a platform admin to promote a member to platform_admin", () => {
    expect(decide("platform_admin", "member", "platform_admin")).toEqual({
      allowed: true,
    });
  });

  it("allows a platform admin every non-guest grant against a lower rank", () => {
    for (const nextRole of ROLES.filter((r) => r !== "guest")) {
      expect(decide("platform_admin", "member", nextRole).allowed).toBe(true);
    }
  });

  it("is never more permissive than canActOnUser about who may be touched", () => {
    // A role change is the only operation that hands out authority, so it must
    // never permit a pairing the ordinary action check would refuse.
    for (const actorRole of ROLES) {
      for (const targetRole of ROLES) {
        const roleChange = decide(actorRole, targetRole, "member").allowed;
        const action = canActOnUser({
          actorId: ACTOR,
          actorRole,
          targetUserId: TARGET,
          targetUserRole: targetRole,
        }).allowed;
        if (roleChange) expect(action).toBe(true);
      }
    }
  });
});

/* ── Report lifecycle ────────────────────────────────────────────────────── */

describe("the report state machine", () => {
  const ALL: ReportStatus[] = ["pending", "reviewing", "resolved", "dismissed"];

  it("permits only the two documented paths", () => {
    const legal: [ReportStatus, ReportStatus][] = [
      ["pending", "reviewing"],
      ["reviewing", "resolved"],
      ["reviewing", "dismissed"],
    ];

    for (const from of ALL) {
      for (const to of ALL) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(canTransitionReport(from, to)).toBe(expected);
      }
    }
  });

  it("has no shortcut from pending to a closed state", () => {
    expect(canTransitionReport("pending", "resolved")).toBe(false);
    expect(canTransitionReport("pending", "dismissed")).toBe(false);
  });

  it("never reopens a closed report", () => {
    for (const from of ["resolved", "dismissed"] as ReportStatus[]) {
      for (const to of ALL) {
        expect(canTransitionReport(from, to)).toBe(false);
      }
    }
  });

  it("refuses a transition to the state already held", () => {
    for (const status of ALL) {
      expect(canTransitionReport(status, status)).toBe(false);
    }
  });

  it("treats resolved and dismissed as terminal and closing", () => {
    expect(isTerminalReportStatus("resolved")).toBe(true);
    expect(isTerminalReportStatus("dismissed")).toBe(true);
    expect(isTerminalReportStatus("pending")).toBe(false);
    expect(isTerminalReportStatus("reviewing")).toBe(false);

    expect(closesReport("resolved")).toBe(true);
    expect(closesReport("dismissed")).toBe(true);
    expect(closesReport("pending")).toBe(false);
    expect(closesReport("reviewing")).toBe(false);
  });
});

/* ── Action semantics ────────────────────────────────────────────────────── */

describe("statusAfterAction", () => {
  it("leaves standing alone for a warning and a content removal", () => {
    expect(statusAfterAction("warning")).toBeNull();
    expect(statusAfterAction("content_removal")).toBeNull();
  });

  it("maps both a suspension and a ban onto banned", () => {
    // `ModerationStatus` has no `suspended` member; the schema draws the
    // distinction on `expiresAt` instead.
    expect(statusAfterAction("suspension")).toBe("banned");
    expect(statusAfterAction("ban")).toBe("banned");
  });

  it("maps shadow_ban onto shadow_banned", () => {
    expect(statusAfterAction("shadow_ban")).toBe("shadow_banned");
  });

  it("restores active for unban and reinstate", () => {
    expect(statusAfterAction("unban")).toBe("active");
    expect(statusAfterAction("reinstate")).toBe("active");
  });

  it("covers every verb", () => {
    for (const action of MODERATION_ACTION_TYPES) {
      expect(() => statusAfterAction(action)).not.toThrow();
    }
  });
});

describe("expiry rules", () => {
  it("requires an expiry for a suspension and forbids one everywhere else", () => {
    for (const action of MODERATION_ACTION_TYPES) {
      const expected = action === "suspension";
      expect(requiresExpiry(action)).toBe(expected);
      expect(allowsExpiry(action)).toBe(expected);
    }
  });
});

describe("targetsContent", () => {
  it("is true only for content_removal", () => {
    for (const action of MODERATION_ACTION_TYPES) {
      expect(targetsContent(action)).toBe(action === "content_removal");
    }
  });
});

describe("notifiesTarget", () => {
  const NOTIFIED: ModerationActionType[] = [
    "warning",
    "suspension",
    "ban",
    "content_removal",
  ];

  it("notifies the four actions a person needs to know about", () => {
    for (const action of NOTIFIED) expect(notifiesTarget(action)).toBe(true);
  });

  it("never notifies a shadow ban", () => {
    // Announcing it would defeat the only property distinguishing it from a
    // ban.
    expect(notifiesTarget("shadow_ban")).toBe(false);
  });

  it("does not notify restorations", () => {
    expect(notifiesTarget("unban")).toBe(false);
    expect(notifiesTarget("reinstate")).toBe(false);
  });
});

describe("actionForStatusChange", () => {
  it("returns null when the status is unchanged", () => {
    expect(actionForStatusChange("active", "active")).toBeNull();
    expect(actionForStatusChange("banned", "banned")).toBeNull();
    expect(actionForStatusChange("shadow_banned", "shadow_banned")).toBeNull();
  });

  it("maps each destination onto the right verb", () => {
    expect(actionForStatusChange("active", "banned")).toBe("ban");
    expect(actionForStatusChange("active", "shadow_banned")).toBe("shadow_ban");
    expect(actionForStatusChange("banned", "active")).toBe("unban");
    expect(actionForStatusChange("shadow_banned", "active")).toBe("reinstate");
  });

  it("only ever produces a verb whose status matches the destination", () => {
    const statuses = ["active", "banned", "shadow_banned"] as const;
    for (const current of statuses) {
      for (const next of statuses) {
        const action = actionForStatusChange(current, next);
        if (action !== null) expect(statusAfterAction(action)).toBe(next);
      }
    }
  });
});

/* ── Lazy suspension expiry (ruling R12) ─────────────────────────────────── */

describe("isSuspensionExpired", () => {
  const NOW = new Date("2026-08-29T12:00:00.000Z");

  it("never expires a permanent ban", () => {
    expect(isSuspensionExpired(null, NOW)).toBe(false);
  });

  it("expires a suspension whose expiry has passed", () => {
    expect(isSuspensionExpired(new Date("2026-08-29T11:59:59.000Z"), NOW)).toBe(true);
  });

  it("does not expire one still in the future", () => {
    expect(isSuspensionExpired(new Date("2026-08-29T12:00:01.000Z"), NOW)).toBe(false);
  });

  it("treats the exact boundary as expired", () => {
    expect(isSuspensionExpired(new Date(NOW), NOW)).toBe(true);
  });
});

/* ── Notification exemption (ruling R11) ─────────────────────────────────── */

describe("moderation notifications bypass ordinary suppression", () => {
  it("marks moderation, and only moderation, unsuppressible", () => {
    expect(isUnsuppressible("moderation")).toBe(true);
    for (const type of [
      "like",
      "comment",
      "follower",
      "message",
      "achievement",
    ] as const) {
      expect(isUnsuppressible(type)).toBe(false);
    }
  });

  it("delivers a muted moderation notification anyway", () => {
    expect(
      resolveDelivery({
        recipientId: "recipient",
        actorId: null,
        type: "moderation",
        blockedEitherWay: false,
        inAppEnabled: false,
        duplicateUnread: false,
      }),
    ).toEqual({ deliver: true });
  });

  it("still suppresses a muted ordinary notification", () => {
    expect(
      resolveDelivery({
        recipientId: "recipient",
        actorId: "actor",
        type: "like",
        blockedEitherWay: false,
        inAppEnabled: false,
        duplicateUnread: false,
      }),
    ).toEqual({ deliver: false, reason: "preference" });
  });

  it("delivers a duplicate moderation notification rather than collapsing it", () => {
    // Two warnings collapsed into one would tell the recipient they had been
    // warned once.
    expect(
      resolveDelivery({
        recipientId: "recipient",
        actorId: null,
        type: "moderation",
        blockedEitherWay: false,
        inAppEnabled: true,
        duplicateUnread: true,
      }),
    ).toEqual({ deliver: true });
  });

  it("does not let the exemption revive a blocked actor's notification", () => {
    // The exemption sits after the block check deliberately, so it can only
    // ever widen delivery to the affected user.
    expect(
      resolveDelivery({
        recipientId: "recipient",
        actorId: "actor",
        type: "moderation",
        blockedEitherWay: true,
        inAppEnabled: true,
        duplicateUnread: false,
      }),
    ).toEqual({ deliver: false, reason: "blocked" });
  });

  it("never delivers a self-notification, even for moderation", () => {
    expect(
      resolveDelivery({
        recipientId: "same",
        actorId: "same",
        type: "moderation",
        blockedEitherWay: false,
        inAppEnabled: true,
        duplicateUnread: false,
      }),
    ).toEqual({ deliver: false, reason: "self" });
  });
});

/* ── Admin capability tiers ──────────────────────────────────────────────── */

describe("admin capability tiers", () => {
  it("opens the admin read surface to all three staff roles", () => {
    for (const role of STAFF) expect(canReadAdminSurface(role)).toBe(true);
    for (const role of NON_STAFF) expect(canReadAdminSurface(role)).toBe(false);
    expect(canReadAdminSurface(null)).toBe(false);
  });

  it("restricts audit logs to platform_admin alone", () => {
    expect(canReadAuditLogs("platform_admin")).toBe(true);
    for (const role of ROLES.filter((r) => r !== "platform_admin")) {
      expect(canReadAuditLogs(role)).toBe(false);
    }
    expect(canReadAuditLogs(null)).toBe(false);
  });

  it("is strictly narrower for audit logs than for the rest of the surface", () => {
    for (const role of [...ROLES, null]) {
      if (canReadAuditLogs(role)) expect(canReadAdminSurface(role)).toBe(true);
    }
  });
});

/* ── Analytics windows ───────────────────────────────────────────────────── */

describe("signupWeekBuckets", () => {
  const NOW = new Date("2026-08-29T15:30:00.000Z");

  it("produces the number of buckets the shipped chart plots", () => {
    expect(signupWeekBuckets(NOW)).toHaveLength(SIGNUP_WEEKS);
    expect(SIGNUP_WEEKS).toBe(8);
  });

  it("returns them oldest first and contiguous", () => {
    const buckets = signupWeekBuckets(NOW);

    for (let i = 1; i < buckets.length; i += 1) {
      expect(buckets[i]!.start.getTime()).toBe(buckets[i - 1]!.end.getTime());
      expect(buckets[i]!.start.getTime()).toBeGreaterThan(
        buckets[i - 1]!.start.getTime(),
      );
    }
  });

  it("includes today in the final bucket", () => {
    const buckets = signupWeekBuckets(NOW);
    const last = buckets.at(-1)!;

    expect(NOW.getTime()).toBeGreaterThanOrEqual(last.start.getTime());
    expect(NOW.getTime()).toBeLessThan(last.end.getTime());
  });

  it("aligns every boundary to UTC midnight", () => {
    for (const bucket of signupWeekBuckets(NOW)) {
      expect(bucket.start.getUTCHours()).toBe(0);
      expect(bucket.start.getUTCMinutes()).toBe(0);
      expect(bucket.start.getUTCSeconds()).toBe(0);
      expect(bucket.start.getUTCMilliseconds()).toBe(0);
    }
  });

  it("labels buckets in the format the shipped chart renders", () => {
    // `mockWeeklySignups` uses "Jun 9" — abbreviated month, no leading zero.
    for (const bucket of signupWeekBuckets(NOW)) {
      expect(bucket.weekLabel).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    }
  });

  it("spans exactly seven days per bucket", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    for (const bucket of signupWeekBuckets(NOW)) {
      expect(bucket.end.getTime() - bucket.start.getTime()).toBe(week);
    }
  });

  it("is stable regardless of the time of day", () => {
    const morning = signupWeekBuckets(new Date("2026-08-29T00:00:01.000Z"));
    const evening = signupWeekBuckets(new Date("2026-08-29T23:59:59.000Z"));

    expect(morning.map((b) => b.weekLabel)).toEqual(evening.map((b) => b.weekLabel));
  });
});
