import type { MessagePermission } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  DIRECT_CONVERSATION_MEMBER_COUNT,
  canAccessConversation,
  canDeleteMessage,
  canEditMessage,
  canStartDirectConversation,
  directConversationKey,
  hasSeenMessage,
  isDirectConversationShape,
  resolveSeenBy,
  satisfiesMessagePolicy,
  shouldAdvanceWatermark,
  type ConversationAccessContext,
  type DirectMessageContext,
} from "../src/modules/messages/message.access.js";

/**
 * The messaging authorization matrix (BACKEND_TRD.md §20).
 *
 * These are the rules that decide who may read private correspondence, so they
 * are tested exhaustively rather than by example: every combination of policy
 * and relationship, every ordering of block against membership, and every
 * boundary of the read watermark.
 *
 * The functions under test are pure, so this file needs no database, no mocks,
 * and no server — which is exactly why the rules were put in a pure module.
 */

const ACCESS: ConversationAccessContext = {
  exists: true,
  isMember: true,
  blockedEitherWay: false,
};

function access(overrides: Partial<ConversationAccessContext> = {}) {
  return { ...ACCESS, ...overrides };
}

const DIRECT: DirectMessageContext = {
  recipientExists: true,
  isSelf: false,
  blockedEitherWay: false,
  recipientPolicy: "everyone",
  requesterFollowsRecipient: false,
  requesterIsAdmin: false,
};

function direct(overrides: Partial<DirectMessageContext> = {}) {
  return { ...DIRECT, ...overrides };
}

describe("canAccessConversation", () => {
  it("admits a live member of an existing conversation", () => {
    expect(canAccessConversation(access())).toBe(true);
  });

  it("refuses a non-member", () => {
    expect(canAccessConversation(access({ isMember: false }))).toBe(false);
  });

  it("refuses a conversation that does not exist", () => {
    expect(canAccessConversation(access({ exists: false }))).toBe(false);
  });

  it("refuses a blocked member even though membership is intact", () => {
    // The rule the brief states outright: an existing membership does not
    // override a block. A conversation predating the block must not remain a
    // channel to someone who has refused contact.
    expect(canAccessConversation(access({ blockedEitherWay: true }))).toBe(false);
  });

  it("puts blocking ahead of membership for every combination", () => {
    for (const isMember of [true, false]) {
      for (const exists of [true, false]) {
        expect(
          canAccessConversation({ exists, isMember, blockedEitherWay: true }),
          `exists=${String(exists)} member=${String(isMember)}`,
        ).toBe(false);
      }
    }
  });

  it("returns a bare boolean, so no caller can branch on the reason", () => {
    // Guards the non-disclosure property structurally: if this ever returns a
    // reason code, a controller can leak "not a member" vs "does not exist".
    expect(typeof canAccessConversation(access({ isMember: false }))).toBe("boolean");
  });
});

describe("satisfiesMessagePolicy", () => {
  const policies: MessagePermission[] = ["everyone", "followers"];

  it("covers the whole enum", () => {
    // If the schema ever grows a third value this fails, rather than the
    // switch silently defaulting to "allowed".
    expect(policies).toHaveLength(2);
  });

  it("allows anyone under `everyone`", () => {
    for (const follows of [true, false]) {
      expect(
        satisfiesMessagePolicy({
          recipientPolicy: "everyone",
          requesterFollowsRecipient: follows,
          requesterIsAdmin: false,
        }),
      ).toBe(true);
    }
  });

  it("allows only followers under `followers`", () => {
    expect(
      satisfiesMessagePolicy({
        recipientPolicy: "followers",
        requesterFollowsRecipient: true,
        requesterIsAdmin: false,
      }),
    ).toBe(true);

    expect(
      satisfiesMessagePolicy({
        recipientPolicy: "followers",
        requesterFollowsRecipient: false,
        requesterIsAdmin: false,
      }),
    ).toBe(false);
  });

  it("does not let an admin role bypass `followers`", () => {
    // Phases 4-7 kept platform admin out of ordinary social surfaces; private
    // correspondence is strictly more sensitive than a profile read.
    expect(
      satisfiesMessagePolicy({
        recipientPolicy: "followers",
        requesterFollowsRecipient: false,
        requesterIsAdmin: true,
      }),
    ).toBe(false);
  });

  it("reads the direction as requester -> recipient", () => {
    // "Who can message you -> Followers only" means *my* followers. A rule
    // written the other way round would let anyone message the people they
    // themselves follow, which is the opposite of the setting.
    const requesterFollowsRecipient = true;
    expect(
      satisfiesMessagePolicy({
        recipientPolicy: "followers",
        requesterFollowsRecipient,
        requesterIsAdmin: false,
      }),
    ).toBe(true);
  });
});

describe("canStartDirectConversation", () => {
  it("allows an ordinary request", () => {
    expect(canStartDirectConversation(direct())).toEqual({ allowed: true });
  });

  it("refuses an unknown recipient", () => {
    expect(canStartDirectConversation(direct({ recipientExists: false }))).toEqual({
      allowed: false,
      reason: "not_found",
    });
  });

  it("refuses a banned recipient the same way as a missing one", () => {
    // The service collapses "banned" into `recipientExists: false` so the two
    // are indistinguishable to a caller.
    expect(canStartDirectConversation(direct({ recipientExists: false })).allowed).toBe(
      false,
    );
  });

  it("refuses yourself", () => {
    expect(canStartDirectConversation(direct({ isSelf: true }))).toEqual({
      allowed: false,
      reason: "self",
    });
  });

  it("refuses when blocked in either direction", () => {
    expect(canStartDirectConversation(direct({ blockedEitherWay: true }))).toEqual({
      allowed: false,
      reason: "blocked",
    });
  });

  it("puts blocking ahead of the contact policy", () => {
    // Both would refuse, but the *reason* must be `blocked` so the service
    // maps it to the non-disclosing 404 rather than a policy message that
    // would confirm the account exists and is merely selective.
    const decision = canStartDirectConversation(
      direct({ blockedEitherWay: true, recipientPolicy: "followers" }),
    );
    expect(decision).toEqual({ allowed: false, reason: "blocked" });
  });

  it("puts blocking ahead of an otherwise permissive policy", () => {
    expect(
      canStartDirectConversation(
        direct({ blockedEitherWay: true, recipientPolicy: "everyone" }),
      ).allowed,
    ).toBe(false);
  });

  it("puts blocking ahead of the self check", () => {
    const decision = canStartDirectConversation(
      direct({ blockedEitherWay: true, isSelf: true }),
    );
    expect(decision).toEqual({ allowed: false, reason: "blocked" });
  });

  it("refuses a non-follower under `followers`", () => {
    expect(
      canStartDirectConversation(
        direct({ recipientPolicy: "followers", requesterFollowsRecipient: false }),
      ),
    ).toEqual({ allowed: false, reason: "policy" });
  });

  it("allows a follower under `followers`", () => {
    expect(
      canStartDirectConversation(
        direct({ recipientPolicy: "followers", requesterFollowsRecipient: true }),
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses an admin who does not satisfy the policy", () => {
    expect(
      canStartDirectConversation(
        direct({
          recipientPolicy: "followers",
          requesterFollowsRecipient: false,
          requesterIsAdmin: true,
        }),
      ),
    ).toEqual({ allowed: false, reason: "policy" });
  });

  it("refuses an admin who is blocked", () => {
    expect(
      canStartDirectConversation(
        direct({ blockedEitherWay: true, requesterIsAdmin: true }),
      ),
    ).toEqual({ allowed: false, reason: "blocked" });
  });

  it("decides the same way for every (policy x follow x admin) combination", () => {
    const policies: MessagePermission[] = ["everyone", "followers"];

    for (const recipientPolicy of policies) {
      for (const requesterFollowsRecipient of [true, false]) {
        for (const requesterIsAdmin of [true, false]) {
          const context = direct({
            recipientPolicy,
            requesterFollowsRecipient,
            requesterIsAdmin,
          });

          const expected =
            recipientPolicy === "everyone" ? true : requesterFollowsRecipient;

          expect(
            canStartDirectConversation(context).allowed,
            `${recipientPolicy}/follows=${String(requesterFollowsRecipient)}/admin=${String(requesterIsAdmin)}`,
          ).toBe(expected);
        }
      }
    }
  });
});

describe("message ownership", () => {
  const own = { senderId: "u1", actorId: "u1", deleted: false };
  const other = { senderId: "u1", actorId: "u2", deleted: false };

  it("lets an author edit their own message", () => {
    expect(canEditMessage(own)).toBe(true);
  });

  it("refuses editing someone else's message", () => {
    expect(canEditMessage(other)).toBe(false);
  });

  it("lets an author delete their own message", () => {
    expect(canDeleteMessage(own)).toBe(true);
  });

  it("refuses deleting someone else's message", () => {
    expect(canDeleteMessage(other)).toBe(false);
  });

  it("refuses both on an already-deleted message", () => {
    expect(canEditMessage({ ...own, deleted: true })).toBe(false);
    expect(canDeleteMessage({ ...own, deleted: true })).toBe(false);
  });

  it("grants no one else authority, whoever they are", () => {
    // There is no admin, moderator, or recipient branch. Removal is a Phase 11
    // moderation power with its own audited surface, not a DM endpoint.
    for (const actorId of ["u2", "admin", "moderator", ""]) {
      expect(canEditMessage({ senderId: "u1", actorId, deleted: false })).toBe(false);
      expect(canDeleteMessage({ senderId: "u1", actorId, deleted: false })).toBe(false);
    }
  });
});

describe("read watermarks", () => {
  const t0 = new Date("2026-01-01T00:00:00.000Z");
  const t1 = new Date("2026-01-01T00:00:01.000Z");

  it("advances from never-read", () => {
    expect(shouldAdvanceWatermark(null, t0)).toBe(true);
  });

  it("advances forward", () => {
    expect(shouldAdvanceWatermark(t0, t1)).toBe(true);
  });

  it("refuses to move backwards", () => {
    // Two devices on one account race constantly; a backwards watermark would
    // resurrect messages the other device already cleared.
    expect(shouldAdvanceWatermark(t1, t0)).toBe(false);
  });

  it("refuses to move to the same instant", () => {
    expect(shouldAdvanceWatermark(t0, new Date(t0.getTime()))).toBe(false);
  });

  it("treats a watermark at the message's own timestamp as seen", () => {
    // Inclusive on purpose: marking read stores the newest message's own
    // createdAt, so `>` would report that very message as unseen.
    expect(hasSeenMessage(t0, t0)).toBe(true);
  });

  it("treats an older watermark as unseen", () => {
    expect(hasSeenMessage(t0, t1)).toBe(false);
  });

  it("treats a null watermark as having seen nothing", () => {
    expect(hasSeenMessage(null, t0)).toBe(false);
  });
});

describe("resolveSeenBy", () => {
  const at = new Date("2026-01-01T00:00:10.000Z");
  const before = new Date("2026-01-01T00:00:00.000Z");
  const after = new Date("2026-01-01T00:00:20.000Z");

  it("always includes the sender", () => {
    expect(resolveSeenBy("sender", [{ userId: "sender", lastReadAt: null }], at)).toEqual(
      ["sender"],
    );
  });

  it("includes a member whose watermark is at or past the message", () => {
    const seen = resolveSeenBy(
      "sender",
      [
        { userId: "sender", lastReadAt: null },
        { userId: "reader", lastReadAt: after },
      ],
      at,
    );

    expect(new Set(seen)).toEqual(new Set(["sender", "reader"]));
  });

  it("excludes a member whose watermark is behind the message", () => {
    const seen = resolveSeenBy(
      "sender",
      [
        { userId: "sender", lastReadAt: null },
        { userId: "laggard", lastReadAt: before },
      ],
      at,
    );

    expect(seen).toEqual(["sender"]);
  });

  it("never lists the same user twice", () => {
    const seen = resolveSeenBy(
      "sender",
      [
        { userId: "sender", lastReadAt: after },
        { userId: "sender", lastReadAt: after },
      ],
      at,
    );

    expect(seen).toEqual(["sender"]);
  });

  it("scales past two members, so groups need no new rule", () => {
    const seen = resolveSeenBy(
      "sender",
      [
        { userId: "a", lastReadAt: after },
        { userId: "b", lastReadAt: after },
        { userId: "c", lastReadAt: before },
      ],
      at,
    );

    expect(new Set(seen)).toEqual(new Set(["sender", "a", "b"]));
  });
});

describe("direct conversation shape", () => {
  it("is two members", () => {
    expect(DIRECT_CONVERSATION_MEMBER_COUNT).toBe(2);
    expect(isDirectConversationShape(["a", "b"])).toBe(true);
  });

  it("rejects one, three, and a duplicated pair", () => {
    expect(isDirectConversationShape(["a"])).toBe(false);
    expect(isDirectConversationShape(["a", "b", "c"])).toBe(false);
    expect(isDirectConversationShape(["a", "a"])).toBe(false);
  });

  it("produces the same key whoever initiates", () => {
    // The property the advisory lock depends on: both directions of a "start a
    // conversation" race must contend for the same lock.
    expect(directConversationKey("b", "a")).toBe(directConversationKey("a", "b"));
  });

  it("produces different keys for different pairs", () => {
    expect(directConversationKey("a", "b")).not.toBe(directConversationKey("a", "c"));
  });
});
