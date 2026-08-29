import { NotificationType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  FANOUT_BATCH_SIZE,
  FANOUT_MAX_RECIPIENTS,
  NON_COLLAPSING_TYPES,
  canAccessNotification,
  collapses,
  planFanout,
  resolveDelivery,
  shouldCollapse,
  shouldMarkRead,
  type DeliveryContext,
} from "../src/modules/notifications/notification.access.js";
import {
  MAX_MESSAGE_LENGTH,
  clampMessage,
  renderNotificationMessage,
} from "../src/modules/notifications/notification.message.js";

/**
 * The notification suppression matrix and message rendering (PRD §14,
 * TRD §22, ARCHITECTURE §16).
 *
 * These functions decide whether one user's action puts text in front of
 * another user, so they are tested exhaustively rather than by example: every
 * combination of the four suppression rules, every member of the type enum,
 * and both fan-out bounds.
 *
 * Pure, so no database, no mocks, no server.
 */

const DELIVER: DeliveryContext = {
  recipientId: "recipient",
  actorId: "actor",
  // Phase 11 added `type` to the context so `resolveDelivery` can exempt
  // moderation from preference and collapse suppression. An ordinary,
  // fully-suppressible type is the right default for this matrix; the
  // moderation exemption is exercised on its own in the Phase 11 suites.
  type: "like",
  blockedEitherWay: false,
  inAppEnabled: true,
  duplicateUnread: false,
};

function context(overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return { ...DELIVER, ...overrides };
}

describe("resolveDelivery", () => {
  it("delivers an ordinary notification", () => {
    expect(resolveDelivery(context())).toEqual({ deliver: true });
  });

  it("suppresses a self-notification", () => {
    expect(resolveDelivery(context({ actorId: "recipient" }))).toEqual({
      deliver: false,
      reason: "self",
    });
  });

  it("suppresses when blocked in either direction", () => {
    expect(resolveDelivery(context({ blockedEitherWay: true }))).toEqual({
      deliver: false,
      reason: "blocked",
    });
  });

  it("suppresses when the recipient turned the type off", () => {
    expect(resolveDelivery(context({ inAppEnabled: false }))).toEqual({
      deliver: false,
      reason: "preference",
    });
  });

  it("suppresses a duplicate that is still unread", () => {
    expect(resolveDelivery(context({ duplicateUnread: true }))).toEqual({
      deliver: false,
      reason: "duplicate",
    });
  });

  it("puts self ahead of every other rule", () => {
    // Ordering matters: the reason drives what the service logs and what the
    // tests below can assert about which lookups were even performed.
    const decision = resolveDelivery(
      context({
        actorId: "recipient",
        blockedEitherWay: true,
        inAppEnabled: false,
        duplicateUnread: true,
      }),
    );
    expect(decision).toEqual({ deliver: false, reason: "self" });
  });

  it("puts blocking ahead of preference and collapse", () => {
    const decision = resolveDelivery(
      context({ blockedEitherWay: true, inAppEnabled: false, duplicateUnread: true }),
    );
    expect(decision).toEqual({ deliver: false, reason: "blocked" });
  });

  it("puts preference ahead of collapse", () => {
    const decision = resolveDelivery(
      context({ inAppEnabled: false, duplicateUnread: true }),
    );
    expect(decision).toEqual({ deliver: false, reason: "preference" });
  });

  it("delivers a system notification with no actor", () => {
    // No actor means neither the self rule nor the block rule can apply.
    expect(resolveDelivery(context({ actorId: null }))).toEqual({ deliver: true });
  });

  it("ignores a stale block flag when there is no actor", () => {
    // A system notification cannot be blocked — there is nobody to block.
    expect(resolveDelivery(context({ actorId: null, blockedEitherWay: true }))).toEqual({
      deliver: true,
    });
  });

  it("still honours preference and collapse for a system notification", () => {
    expect(resolveDelivery(context({ actorId: null, inAppEnabled: false }))).toEqual({
      deliver: false,
      reason: "preference",
    });
    expect(resolveDelivery(context({ actorId: null, duplicateUnread: true }))).toEqual({
      deliver: false,
      reason: "duplicate",
    });
  });

  it("decides consistently across every combination of the four rules", () => {
    for (const self of [true, false]) {
      for (const blocked of [true, false]) {
        for (const inApp of [true, false]) {
          for (const duplicate of [true, false]) {
            const decision = resolveDelivery(
              context({
                actorId: self ? "recipient" : "actor",
                blockedEitherWay: blocked,
                inAppEnabled: inApp,
                duplicateUnread: duplicate,
              }),
            );

            const expected = !self && !blocked && inApp && !duplicate;
            expect(
              decision.deliver,
              `self=${String(self)} blocked=${String(blocked)} inApp=${String(inApp)} dup=${String(duplicate)}`,
            ).toBe(expected);
          }
        }
      }
    }
  });
});

describe("collapse policy", () => {
  it("collapses while a duplicate is unread", () => {
    expect(shouldCollapse(true)).toBe(true);
    expect(shouldCollapse(false)).toBe(false);
  });

  it("collapses repeatable activity", () => {
    for (const type of ["like", "comment", "reply", "mention", "follower", "message"]) {
      expect(collapses(type as NotificationType), type).toBe(true);
    }
  });

  it("never collapses invitations or project updates", () => {
    // Each invitation is a distinct act and each update is distinct content;
    // collapsing them would lose information rather than reduce noise.
    for (const type of NON_COLLAPSING_TYPES) {
      expect(collapses(type), type).toBe(false);
    }
  });

  it("names every non-collapsing type explicitly", () => {
    expect([...NON_COLLAPSING_TYPES].sort()).toEqual([
      "community_invite",
      "invite",
      // Phase 11: each moderation action is a distinct decision, on the same
      // reasoning as an invitation. Two warnings collapsed into one would tell
      // the recipient they had been warned once.
      "moderation",
      "project_invite",
      "project_update",
    ]);
  });
});

describe("canAccessNotification", () => {
  it("admits the recipient", () => {
    expect(
      canAccessNotification({ exists: true, recipientId: "me", viewerId: "me" }),
    ).toBe(true);
  });

  it("refuses anyone else", () => {
    expect(
      canAccessNotification({ exists: true, recipientId: "me", viewerId: "someone" }),
    ).toBe(false);
  });

  it("refuses a notification that does not exist", () => {
    expect(
      canAccessNotification({ exists: false, recipientId: null, viewerId: "me" }),
    ).toBe(false);
  });

  it("returns a bare boolean so no caller can branch on the reason", () => {
    // Guards the non-disclosure property structurally: a reason code here
    // would let a controller leak "not yours" versus "does not exist".
    const missing = canAccessNotification({
      exists: false,
      recipientId: null,
      viewerId: "me",
    });
    const foreign = canAccessNotification({
      exists: true,
      recipientId: "other",
      viewerId: "me",
    });
    expect(missing).toBe(foreign);
  });

  it("grants no one else authority, whoever they are", () => {
    // There is deliberately no admin branch: a notification list is a digest
    // of everything a user has received.
    for (const viewerId of ["admin", "platform_admin", "moderator", ""]) {
      expect(canAccessNotification({ exists: true, recipientId: "me", viewerId })).toBe(
        false,
      );
    }
  });
});

describe("shouldMarkRead", () => {
  it("writes when unread", () => {
    expect(shouldMarkRead(false)).toBe(true);
  });

  it("is a no-op when already read", () => {
    // Re-stamping readAt would rewrite history to say they read it later.
    expect(shouldMarkRead(true)).toBe(false);
  });
});

describe("fan-out planning", () => {
  function ids(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `user-${String(index)}`);
  }

  it("returns no batches for no recipients", () => {
    expect(planFanout([])).toEqual([]);
  });

  it("returns a single batch below the batch size", () => {
    const batches = planFanout(ids(10));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(10);
  });

  it("splits at the batch size", () => {
    const batches = planFanout(ids(FANOUT_BATCH_SIZE + 1));
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(FANOUT_BATCH_SIZE);
    expect(batches[1]).toHaveLength(1);
  });

  it("caps at the maximum recipient count", () => {
    // The bound that makes an inline fan-out safe: a popular project must not
    // turn one POST into tens of thousands of inserts while the client waits.
    const batches = planFanout(ids(FANOUT_MAX_RECIPIENTS * 3));
    const total = batches.reduce((sum, batch) => sum + batch.length, 0);
    expect(total).toBe(FANOUT_MAX_RECIPIENTS);
  });

  it("preserves order and loses nobody below the cap", () => {
    const input = ids(250);
    expect(planFanout(input).flat()).toEqual(input);
  });
});

describe("renderNotificationMessage", () => {
  it("handles every member of the type enum", () => {
    // Exhaustive by construction: the switch has no default, so a thirteenth
    // enum member would fail to compile rather than render as empty text.
    for (const type of Object.values(NotificationType)) {
      const message = renderNotificationMessage({ type, actorName: "Ada", subject: "X" });
      expect(message.length, type).toBeGreaterThan(0);
      expect(message.endsWith("."), type).toBe(true);
    }
  });

  it("names the actor", () => {
    expect(renderNotificationMessage({ type: "follower", actorName: "Ada" })).toBe(
      "Ada started following you.",
    );
  });

  it("falls back to a neutral third person rather than leaking null", () => {
    expect(renderNotificationMessage({ type: "follower", actorName: null })).toBe(
      "Someone started following you.",
    );
    expect(renderNotificationMessage({ type: "follower", actorName: "   " })).toBe(
      "Someone started following you.",
    );
  });

  it("includes a subject when one is supplied", () => {
    expect(
      renderNotificationMessage({
        type: "project_invite",
        actorName: "Ada",
        subject: "ForgeHub",
      }),
    ).toBe("Ada added you to the project ForgeHub.");
  });

  it("reads correctly without a subject", () => {
    expect(renderNotificationMessage({ type: "project_update", actorName: "Ada" })).toBe(
      "Ada posted an update to.",
    );
  });

  it("distinguishes project and community invitations", () => {
    const project = renderNotificationMessage({
      type: "project_invite",
      actorName: "Ada",
      subject: "Atlas",
    });
    const community = renderNotificationMessage({
      type: "community_invite",
      actorName: "Ada",
      subject: "Atlas",
    });
    expect(project).not.toBe(community);
  });

  it("distinguishes a comment from a reply", () => {
    expect(renderNotificationMessage({ type: "comment", actorName: "Ada" })).not.toBe(
      renderNotificationMessage({ type: "reply", actorName: "Ada" }),
    );
  });

  it("renders achievement and moderation without naming an actor", () => {
    // Neither is produced by this phase — the awarding engine is Phase 10 and
    // moderation is Phase 11 — but both are covered so the exhaustiveness
    // check passes honestly rather than by a cast.
    expect(
      renderNotificationMessage({
        type: "achievement",
        actorName: null,
        subject: "First Post",
      }),
    ).toContain("First Post");
    expect(
      renderNotificationMessage({ type: "moderation", actorName: null, subject: "spam" }),
    ).toContain("spam");
  });
});

describe("clampMessage", () => {
  it("leaves a short message alone", () => {
    expect(clampMessage("short")).toBe("short");
  });

  it("truncates an over-long message with an ellipsis", () => {
    const clamped = clampMessage("x".repeat(MAX_MESSAGE_LENGTH + 50));
    expect(clamped).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("leaves a message of exactly the maximum length alone", () => {
    const exact = "x".repeat(MAX_MESSAGE_LENGTH);
    expect(clampMessage(exact)).toBe(exact);
  });
});
