# Messaging (Phase 8)

Direct conversations, real-time delivery, typing indicators, read receipts,
unread counts, reactions, attachment references, presence, and search within a
conversation.

Specification: `BACKEND_PRD.md` §13, `BACKEND_TRD.md` §19–21,
`BACKEND_ARCHITECTURE.md` §13–15. Phase order from `BACKEND_ARCHITECTURE.md` §38.

**No schema change was required.** `Conversation`, `ConversationMember`,
`Message`, `MessageAttachment`, and `MessageReaction` were already present from
Phase 2, with the two indexes this module needs. Migration count remains **2**.

---

## Architecture

```
Client
  ↓  REST (Express)            ↓  Socket.IO
  ↓                            ↓  handshake → verified access token
  ↓  requireAuth               ↓  socket.data.user
  └──────────┬─────────────────┘
             ↓
        messages.service      ← the single authorization layer
             ↓
        messages.repository
             ↓
          PostgreSQL
             ↓
        message.view.ts       ← the single projection layer
             ↓
   response  +  message:new → recipients' user rooms
```

Both transports enter the same service functions. **There is no socket-only
path into the data**, so there is no second place for an authorization check to
be missing — which is the single most important structural decision in this
phase.

### Files

| File                                      | Role                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `modules/messages/message.access.ts`      | Pure authorization. No I/O, no Prisma. Exhaustively unit-tested. |
| `modules/messages/messages.repository.ts` | Every query. Nothing else touches Prisma.                        |
| `modules/messages/messages.service.ts`    | The gate, the ordering of checks, the business rules.            |
| `modules/messages/message.view.ts`        | The only place a row becomes a response.                         |
| `modules/messages/messages.schema.ts`     | Zod, shared by HTTP bodies **and** socket frames.                |
| `modules/messages/messages.controller.ts` | HTTP adapter; also fans out over Socket.IO.                      |
| `modules/messages/messages.routes.ts`     | `/api/v1/messages`, `requireAuth` on every route.                |
| `sockets/message.socket.ts`               | `message:*`, `conversation:*` handlers and outbound emits.       |
| `sockets/presence.socket.ts`              | Redis presence, heartbeat, online/offline transitions.           |

---

## REST API

All routes are under `/api/v1/messages` and **all require authentication**.
Unlike projects, posts, and communities — each of which has a public face —
private correspondence has no anonymous reader, so there is no `optionalAuth`
route in this module.

| Method | Path                                             | Purpose                                      |
| ------ | ------------------------------------------------ | -------------------------------------------- |
| GET    | `/conversations`                                 | The caller's conversations, cursor-paginated |
| POST   | `/conversations`                                 | Open (or reuse) a direct conversation        |
| GET    | `/conversations/:conversationId`                 | One conversation                             |
| GET    | `/conversations/:conversationId/messages`        | Message history, cursor-paginated            |
| POST   | `/conversations/:conversationId/messages`        | Send                                         |
| GET    | `/conversations/:conversationId/messages/search` | Search within this conversation              |
| POST   | `/conversations/:conversationId/read`            | Move the caller's read watermark             |
| GET    | `/conversations/:conversationId/unread`          | Unread count                                 |
| PATCH  | `/:messageId`                                    | Edit (author only)                           |
| DELETE | `/:messageId`                                    | Soft-delete (author only)                    |
| POST   | `/:messageId/reactions`                          | Add a reaction                               |
| DELETE | `/:messageId/reactions/:emoji`                   | Remove your own reaction                     |

### Deviation from the brief's example route list

The brief listed `PATCH /api/v1/messages/messages/:messageId` and its siblings.
Those are implemented as `PATCH /api/v1/messages/:messageId` instead — the
`messages/messages/` stutter is what the established convention rules out.
Phase 6 addresses an individually-addressable child on its own path
(`/comments/:id`, never `/posts/comments/:id`), and `ARCHITECTURE` §11 allocates
`/api/v1/messages` to this _domain_, not to the conversation sub-resource alone.
The brief explicitly anticipated this: _"do not blindly follow the example
routes above if the existing API architecture specifies a different canonical
structure."_

`/conversations` and everything beneath it is declared before `/:messageId`, and
`messageId` is uuid-validated, so the literal segment can never be parsed as an
id.

---

## Socket events

Every `client → server` event takes an acknowledgement callback answering
`{ ok: true, data }` or `{ ok: false, error: { code, message } }`, reusing the
REST error codes — a socket frame has no status line, so failures need a channel
of their own.

| Event                          | Direction | Payload                                                                                              |
| ------------------------------ | --------- | ---------------------------------------------------------------------------------------------------- |
| `conversation:join`            | → server  | `{ conversationId }`, DB-authorized                                                                  |
| `conversation:leave`           | → server  | `{ conversationId }`                                                                                 |
| `message:send`                 | → server  | `{ conversationId, content?, attachments? }`                                                         |
| `message:new`                  | → client  | `{ message }`                                                                                        |
| `message:read`                 | both      | in `{ conversationId, messageId? }`, out `{ conversationId, userId, lastReadAt, lastReadMessageId }` |
| `message:deleted`              | → client  | `{ id, conversationId }`                                                                             |
| `message:typing`               | both      | in `{ conversationId }`, out `{ conversationId, userId, username }`                                  |
| `message:stop_typing`          | both      | as `message:typing`                                                                                  |
| `user:online` / `user:offline` | → client  | `{ userId, online, at }`                                                                             |
| `presence:update`              | → client  | `{ userId, online, at }`                                                                             |

### Where events go, and why

**`message:new`, `message:read`, and `message:deleted` go to `user:{id}` rooms**,
resolved from `ConversationMember` rows in the database — never to the
conversation room and never to socket ids. Three reasons:

1. **Authorization from the database.** The recipient list is `SELECT`ed, not
   inferred from who happens to be listening.
2. **No duplicate delivery.** Each socket is in exactly one user room, so a
   client with the thread open cannot receive the same message twice — which it
   would if the event went to both room types.
3. **Delivery while the thread is closed.** An inbox badge must update for
   someone not looking at that conversation, and such a person is in no
   conversation room.

**`message:typing` and `message:stop_typing` go to `conversation:{id}`**, because
that is precisely their audience: only someone with the thread open can see a
typing bubble. Membership is still re-verified in the database before each relay.

**`presence:*` goes to the user's conversation partners**, not to every connected
socket. Broadcasting presence would turn a chat feature into a live directory of
who is at their desk.

---

## Authorization model

### One gate

`loadAccessibleConversation(conversationId, actor)` is the single entry point for
every conversation-scoped operation — reads, sends, receipts, reactions, edits,
deletes, and search. A child operation that loaded the conversation itself would
be one refactor away from forgetting the block check.

It always throws **404, never 403**. A 403 would confirm the conversation exists
and, in the block case, announce the block to the person it was raised against.

### The ordering of checks

1. **Blocking outranks everything** — not membership, not an existing
   conversation, not a permissive `whoCanMessage`, not a platform admin role.
2. **Membership, from the database** — never from a socket room, never from a
   client claim.
3. **`whoCanMessage`**, which is a _contact_ policy and therefore the last gate.

The ordering lives in pure functions in `message.access.ts` with their own
exhaustive tests, so it is a property of tested code rather than of control flow
that happens to read correctly today.

### Never trusted

`userId`, `senderId`, `actorId`, `participantIds`, `conversationId` in a body,
`seenByUserIds`, `createdAt`, `editedAt`, and membership or permission claims are
absent from every write schema. Zod strips unknown keys, so a client that sends
them is not rejected — the values simply never reach a service. `messages-security.test.ts`
asserts each of these rather than trusting this paragraph.

### Platform admin has no messaging power

An admin cannot read someone else's conversation and cannot bypass
`whoCanMessage`. Phases 4–7 kept platform admin out of ordinary social surfaces;
private correspondence is the last place it should arrive by accident. A future
moderation phase that wants this must change `message.access.ts` and its tests —
which is the point.

---

## `whoCanMessage` enforcement

The setting was stored from Phase 4 and unenforced until now
(`USERS_AND_SOCIAL_GRAPH.md`: _"enforcement belongs with messaging in Phase 8"_).

| Policy               | Rule                                     |
| -------------------- | ---------------------------------------- |
| `everyone` (default) | Anyone may message                       |
| `followers`          | The **sender must follow the recipient** |

The direction matters and is easy to invert. "Who can message you → Followers
only" (`privacy-form.tsx`) means _my followers_, so the edge runs
sender → recipient. The context field is named `requesterFollowsRecipient`
rather than `isFollowing` for exactly this reason, and there is a test asserting
that the recipient following the sender is _not_ sufficient.

A user with no `UserSettings` row defaults to `everyone`, matching the schema
default. Treating the absence as "nobody may message me" would silently mute
most of the user base.

### Enforced on every send, not only at creation

The brief lists the contact policy under `message:send`, not only under
conversation creation, and the consequence is deliberate: if someone switches to
"followers only" and you do not follow them, an open thread stops accepting new
messages from you (**403** — you already know the thread exists). History stays
readable to both sides; only the write closes. A policy applied solely at
creation time would be defeated by opening a conversation first and messaging
later.

Groups are exempt by construction: a group's gate is its membership, and
applying a pairwise contact preference to a room would let one member's setting
silence another member's messages to everybody.

---

## Block precedence

A block in **either** direction closes the conversation entirely — reads,
sends, reactions, edits, deletes, receipts, unread counts, and search all 404.

Membership does not override a block. A conversation predating the block would
otherwise remain an open channel to someone who has explicitly refused contact.

The check runs against **every** other live participant, not "the other one", so
it is already correct for a group: one block anywhere in the room closes it for
the blocked party.

Blocking also takes effect **mid-session** on an open socket. A socket sitting in
a conversation room had authorization when it joined; the handlers re-resolve it
from the database on every frame, so a block lands on the next frame rather than
the next reconnect.

---

## Duplicate direct conversations

There is no unique index that can span two `ConversationMember` rows, so the
Phase 4 approach (`@@unique([followerId, followingId])` arbitrating duplicate
follows) is unavailable. A denormalized `pairKey` column would work but is a
schema change, and the existing schema is not insufficient — PostgreSQL supplies
the arbiter directly.

`findOrCreateDirectConversation` takes **`pg_advisory_xact_lock`** on a hash of
the canonically sorted pair, inside the transaction:

- Two simultaneous "message this person" requests from opposite directions
  contend for the same lock; the first creates, the second blocks, re-reads, and
  finds it.
- The lock releases with the transaction, including on rollback, so a failure
  cannot strand it.
- Hash collisions between unrelated pairs are possible and harmless — two pairs
  serialize for the few milliseconds a lookup takes.

`messages-repo.test.ts` fires four concurrent requests from both directions and
asserts exactly one conversation and exactly one `created: true`.

---

## Read receipts

Per-member watermarks, using the columns the schema already provides and the
design its own comment prescribes: _"a receipt row per (message × member) would
grow quadratically in group threads."_ **No per-message-per-user receipt table
was created.**

- `ConversationMember.lastReadAt` — the instant
- `ConversationMember.lastReadMessageId` — what it pointed at

**Monotonic, enforced in SQL.** `advanceWatermark` matches no row unless the
candidate is strictly newer than what is stored. A read-modify-write would let a
phone scrolled to the top of the thread drag the watermark backwards past what a
laptop already cleared, and unread counts would oscillate for no visible reason.
The pure `shouldAdvanceWatermark` mirrors the rule for unit testing; the SQL
clause is what actually holds under concurrency.

`seenByUserIds` on a message is **derived** from the members' watermarks, with
`>=` (marking read stores the newest message's own `createdAt`, so `>` would
report that very message as unseen). The sender is always included.

The raw watermarks are never published per member — that would tell everyone in
a thread exactly when each person last looked at it.

---

## Unread counts

One query per page, never per conversation, and it loads no messages:

```sql
SELECT m."conversationId", COUNT(*)
FROM "messages" m
JOIN "conversation_members" cm
  ON cm."conversationId" = m."conversationId"
 AND cm."userId" = $1 AND cm."leftAt" IS NULL
WHERE m."conversationId" = ANY($2)
  AND m."deletedAt" IS NULL
  AND m."senderId" <> $1
  AND (cm."lastReadAt" IS NULL OR m."createdAt" > cm."lastReadAt")
GROUP BY m."conversationId"
```

Raw SQL because the cutoff lives on the _member_ row and Prisma's `groupBy`
cannot express "count rows newer than a value that varies per group". The
alternative is an N+1 the brief rules out. Rides the
`(conversationId, createdAt DESC)` index.

Three conditions, each deliberate: a deleted message is not owed a read; your
own messages are never unread to you; a null watermark means the whole thread is
unread rather than none of it.

---

## Presence

Redis only. Nothing high-frequency touches PostgreSQL (`ARCHITECTURE` §15).

**Key:** `presence:user:{userId}` — a **set of socket ids**, not a flag.

| Event           | Action                                                                         |
| --------------- | ------------------------------------------------------------------------------ |
| connect         | `SADD` this socket id, `EXPIRE` the key, announce online if the set went 0 → 1 |
| disconnect      | `SREM` this socket id, announce offline only if `SCARD` hits 0                 |
| heartbeat (20s) | `EXPIRE` again for every locally connected user                                |

**TTL: 60 seconds**, refreshed at 20 — two refreshes fit in every window, so a
single delayed tick cannot flap a live user offline.

A single flag cannot tell one tab from three, which is the bug the brief names:
_"do not mark a user offline merely because one browser tab disconnected while
another active socket remains."_ A counter would be simpler and wrong — a
process that dies without running its disconnect handlers leaves the count
permanently inflated and the user online forever. Set members are idempotent, and
the TTL sweeps away whatever a crash stranded.

Redis is the source of truth rather than the local socket server, so the answer
stays correct when a second instance appears (§14's horizontal-scaling note).

Presence is best-effort: a Redis failure is logged and swallowed, never allowed
to interrupt message delivery, which does not depend on presence at all.

---

## Message lifecycle

**Send.** Gate → contact policy → cross-field validation → persist message,
attachments, and `lastMessageAt` in one transaction → _then_ emit. Nothing in the
service emits, so a handler structurally cannot broadcast before persistence
succeeds.

`lastMessageAt` is set to the message's own `createdAt`, so the ordering column
and the row it describes agree exactly.

**Edit.** Author only — no admin or moderator branch; rewriting someone else's
words is not a moderation power any specification here grants. Attachments cannot
be changed by an edit: re-pointing one afterwards would let a sender swap a file
the recipient has already read and possibly trusted. Deleting and resending is
the honest path.

**Delete.** Soft, using the schema's `deletedAt`. The row, its attachments, and
its reactions all survive; the message stops being returned by any read path.
Author only — the brief permits otherwise only if a specification explicitly
grants it, and none does. PRD §17 gives moderators content removal, but that is
the Phase 11 moderation surface with its own audit trail.

`lastMessageAt` is deliberately not rewound on delete. It is an activity marker,
not a pointer; the conversation list resolves the actual last live message
separately and already skips deleted rows.

**Status codes.** 403 for another member of the same conversation (the message is
not a secret from them — only the authority is missing); 404 for anyone outside
it.

---

## Attachments

**URLs only. No uploads.** No Cloudinary, no multipart, no file storage, no
binary processing, no upload endpoint. Those are the later uploads phase.

`url` is a bounded string, deliberately **not** `z.string().url()`, matching the
Phase 5 and Phase 7 precedent for media fields: the shipped fixtures use opaque
references, and URL validation would make the API reject its own seed data.

`sizeBytes` is client-reported and treated as a label, not a fact — nothing is
measured because nothing is stored. Bounded so the column cannot be used as free
storage. Max 10 attachments per message.

---

## Reactions

`@@unique([messageId, userId, emoji])` is the arbiter, as in every other
uniqueness path in this codebase. A duplicate raises `P2002`, which is caught and
reported as "already there" — the endpoint answers 201 with an unchanged count
rather than a 409 the UI would have to explain. The end state the caller asked
for is the end state they get.

Reactions are grouped by emoji in the projection (`{ emoji, count, userIds,
reactedByViewer }`) because the UI renders one chip per emoji; insertion order is
preserved so chips do not reshuffle between renders.

Any member may react to any live message, including their own. What reacting is
_not_ is a way to touch a message in a conversation the actor cannot open —
which is why it goes through the same gate.

---

## Search

Within one conversation only. `contains` with `mode: "insensitive"` compiles to
`ILIKE '%term%'`.

Chosen over `to_tsvector` deliberately: full-text search stems and tokenizes,
which is right for prose and wrong for a chat thread where people search for
fragments, handles, and bits of code. It also needs no new index, no new column,
and no migration. `ARCHITECTURE` §13 asks only that search be
"PostgreSQL-compatible"; Phase 10 owns real search. **No Elasticsearch.**

The conversation id is a path segment applied in the query itself, so there is no
expressible query that spans conversations the caller cannot access. Deleted
messages are excluded in the query rather than filtered after paging — a filter
after paging returns short pages.

---

## Group-chat compatibility

Group conversations are **not implemented**. No group creation, no group
administration, no group endpoints or socket events. `isGroup` is always false.

But nothing else in the module assumes two participants. Repository queries, the
access gate, read watermarks, unread counting, `seenByUserIds`, reactions, and
delivery all operate on a member _set_ of arbitrary size. The "exactly two" rule
is stated in exactly one place — `isDirectConversationShape` /
`DIRECT_CONVERSATION_MEMBER_COUNT` in `message.access.ts` — and consulted only by
conversation creation.

Implementing group chat means adding a second creation path, not unpicking an
assumption spread across the module.

---

## Test coverage

| Suite                       | Tests | Subject                                                                                                                                                                                    |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `messages-unit.test.ts`     | 46    | The authorization matrix, pure. Every (policy × follow × admin) combination, block ordering, watermark boundaries, ownership.                                                              |
| `messages-repo.test.ts`     | 43    | Real PostgreSQL: the advisory lock under a 4-way race, the raw unread query, SQL-level watermark monotonicity, reaction uniqueness under concurrency, cursor paging, soft-delete survival. |
| `messages.test.ts`          | 39    | REST end to end: conversations, history, paging, editing, deleting, reactions, receipts, unread, search, 404-not-403.                                                                      |
| `messages-security.test.ts` | 28    | Every spoofing and escalation attempt the brief names, plus block precedence, `whoCanMessage`, and "no anonymous access" across all 12 routes.                                             |
| `messages-socket.test.ts`   | 32    | Real server, real clients: handshake, rooms, send/read/typing, spoofed ids, mid-session block cutoff, offline persistence, presence multi-tab and reconnect, cross-transport delivery.     |
| `openapi.test.ts`           | +5    | Paths, schemas, bearer on every operation, no 403 on reads, documented socket events.                                                                                                      |

---

## Intentionally deferred

| Deferred                                                                                                                              | Owner                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Group conversations**                                                                                                               | Future — architecture is compatible, feature is not built |
| **Notifications** — no `Notification` rows, no calls to the notification port                                                         | Phase 9                                                   |
| **Global search** across users/projects/posts                                                                                         | Phase 10                                                  |
| **File uploads / Cloudinary** — attachment references only                                                                            | Phase 11                                                  |
| **Reporting or moderating messages**                                                                                                  | Phase 11                                                  |
| **Socket.IO Redis adapter** — required only _"when horizontally scaled"_ (§14)                                                        | Deployment                                                |
| **`ConversationMember.isMuted`** — column exists, no endpoint sets it; it is a notification preference and belongs with notifications | Phase 9                                                   |
| **Leaving a conversation** — `leftAt` is honoured on read but no endpoint sets it; the PRD lists no such action for direct messages   | Future                                                    |
| **Message pagination by date range, pinning, forwarding, drafts**                                                                     | Not specified                                             |

### Not implemented on purpose

- **No notification port call.** The seam in `src/ports/notification.port.ts`
  stays a no-op. `PortNotificationType` does not include `message`, and adding
  it would be Phase 9 work landing early.
- **No `Notification` rows** are created by any messaging path.
- **No typing state in PostgreSQL.** Typing is relayed and forgotten.
