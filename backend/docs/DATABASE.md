# Database architecture

Decisions behind `prisma/schema.prisma` (Backend Phase 2). Read alongside
BACKEND_TRD.md §9–11 and BACKEND_ARCHITECTURE.md §7–13.

## Source reconciliation

The schema was derived from three sources that did not fully agree. Order of
authority, and why:

1. **The frontend's domain types** (`../src/types/*.ts`) — live, rendering
   code. The API has to serve exactly these shapes or the finished UI breaks.
2. **PRD.md / BACKEND_PRD.md** — product requirements.
3. **BACKEND_TRD.md §10 / BACKEND_ARCHITECTURE.md §7** — the entity checklist.

### Conflicts resolved in favor of the frontend

| Conflict             | Docs say                                                         | Frontend says                                                                           | Resolution                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User roles           | `USER`, `MODERATOR`, `ADMIN`, `SUPER_ADMIN` (TRD §14)            | `guest`, `member`, `verified_builder`, `moderator`, `community_admin`, `platform_admin` | **Frontend.** `AppSidebar` and `AdminGuard` already gate on these six via `lib/rbac.ts`. Adopting the doc's four would break shipped authorization code. |
| Project member roles | Owner, Admin, Developer, Designer, Contributor                   | `owner`, `collaborator`, `contributor`                                                  | **Union of both.** The frontend's three stay valid; the richer set becomes available to later phases.                                                    |
| Notification types   | adds `REPLY`, `PROJECT_INVITE`, `COMMUNITY_INVITE`, `MODERATION` | 8 types incl. a generic `invite`                                                        | **Union.** Generic `invite` retained so existing frontend rendering keeps working.                                                                       |

### Entities the docs omit but the frontend requires

These have no entry in the TRD entity list and would have been missed by
building from the documentation alone:

- **`Poll` / `PollOption` / `PollVote`** — `Post.poll` is rendered by
  `PollVoter`, including live vote counts.
- **Code snippets** — `Post.codeSnippet` (`{ language, code }`), rendered by
  `CodeBlock`. Stored as two columns on `Post`, not a child table: a post
  carries at most one snippet.
- **`CommunityEvent`** — `Community.events`, rendered by `CommunityEvents`
  and the dashboard's upcoming-events widget.
- **`Badge` / `UserBadge`** — `User.badges`, distinct from achievements.
- **Reputation fields** — `xp`, `builderRank`, `dailyStreak`,
  `contributionScore`, `communityScore` (PRD §4.10), rendered by the
  leaderboard and profile header.
- **`FundingStage`**, `progressPercent`, `techStack`, `gallery`, and project
  metrics (`views` / `likes` / `followers`).
- **`Block`** — the Settings → Privacy page lists blocked users.

## Structural decisions

### User / Profile split

TRD §10 models them separately; the frontend consumes one joined `User`
object. Kept **separate** in the database, joined on read. Credential rows
stay narrow, and a public profile read never touches `passwordHash`.

### Denormalized counters

`User.followersCount`, `Post.likesCount`, `Project.viewsCount`,
`Community.memberCount`, `PollOption.voteCount`, and siblings duplicate data
that could be derived with `COUNT`.

This is deliberate and is the one place the schema knowingly departs from
TRD §9's "avoid storing derived data". Justification: every one of these is
rendered on _every row_ of a list view (feed, leaderboard, discovery grid).
Deriving them would mean a correlated subquery per row — the textbook N+1 the
same document forbids in §38. The tradeoff is that services must update the
counter inside the same transaction as the underlying write.

### Polymorphic targets

`Notification`, `Report`, `ModerationAction`, and `AuditLog` all reference
"some entity" via `(entityType, entityId)` rather than a real foreign key.

A nullable FK per target type would add ~8 mostly-empty columns and 8 indexes
to each table. The cost is that referential integrity for these is the
application's responsibility — accepted because they are append-oriented
records whose targets may legitimately be soft-deleted anyway.

### Read receipts as watermarks

The frontend's `Message.seenByUserIds` implies a row per (message × reader).
Stored instead as `ConversationMember.lastReadAt` / `lastReadMessageId`.

A receipt table grows quadratically in group threads (100 messages × 50
members = 5,000 rows per conversation) to answer a question a single
watermark answers. `seenByUserIds` is derived at read time.

### Comment threading

Single-table adjacency list (`Comment.parentCommentId`). Not a closure table
or nested set — the UI renders one level of replies, and the brief explicitly
warns against an over-complicated comment architecture.

### Tags vs. string arrays

- **`Tag` entity** (+ `ProjectTag` / `CommunityTag` joins) for discovery-facing
  taxonomy — Phase 10 search needs to filter and count by tag.
- **Native `String[]`** for `skills`, `techStack`, `gallery` — rendered as
  chips, never queried relationally. A join table would add cost with no
  query benefit.

### Contribution heatmap

`ContributionDay` (`types/profile.ts`) is **not** a table. It is computed from
`Post.createdAt` + `ProjectUpdate.createdAt`, both indexed on `createdAt`. If
that aggregation becomes hot, a materialized view is the next step — not a
duplicated write path.

## Deletion strategy

Soft delete (`deletedAt`) on `User`, `Project`, `Post`, `Comment`, `Message`,
`Community`, `ProjectUpdate`, `Conversation`. **Queries must filter it.**

Foreign keys follow one rule: _cascade when the child is meaningless without
the parent; restrict when deleting would destroy history._

| Behavior   | Applies to                                                                                                                | Why                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Cascade`  | Profile, settings, sessions, tokens, likes, bookmarks, memberships, milestones, poll options, attachments                 | Meaningless without the parent.                                                                      |
| `Restrict` | `Post.author`, `Comment.author`, `Project.owner`, `Community.owner`, `Message.sender`, `Report.reporter`                  | Hard-deleting a user must not silently destroy content or reports. Account closure is a soft delete. |
| `SetNull`  | `Notification.actor`, `AuditLog.actor`, `ModerationAction.moderator`, `Report.reviewer`, `Post.project`, `Post.community` | The record must outlive the reference.                                                               |

`AuditLog` has no `updatedAt` and no soft delete — it is append-only by
design (TRD §29). Application database roles should hold `INSERT`/`SELECT`
only on it.

## Indexing

Indexes were chosen from actual frontend query patterns, not applied blindly.

**Composite indexes earning their keep:**

| Index                                              | Query it serves                                        |
| -------------------------------------------------- | ------------------------------------------------------ |
| `posts(visibility, deletedAt, createdAt DESC)`     | Default feed — filter public + undeleted, sort newest. |
| `posts(deletedAt, likesCount DESC)`                | "Trending" / "Popular today".                          |
| `projects(visibility, deletedAt, likesCount DESC)` | Trending projects widget.                              |
| `notifications(userId, createdAt DESC)`            | Notification panel.                                    |
| `notifications(userId, isRead)`                    | Unread badge count.                                    |
| `messages(conversationId, createdAt DESC)`         | Thread pagination.                                     |
| `reports(status, createdAt)`                       | Moderation queue — pending first, oldest first.        |
| `bookmarks(userId, createdAt DESC)`                | A user's saved posts.                                  |
| `community_members(communityId, role)`             | Moderator lists.                                       |
| `users(xp DESC)`                                   | Leaderboard.                                           |

Every join table is indexed on its non-leading key so traversal works in both
directions (a composite primary key only indexes the leading column).

## Pagination support

The schema is built for the Phase 1 helpers in `src/utils/pagination.ts`:

- **Cursor pagination** (feed, messages, notifications) — every high-volume
  table has a `createdAt DESC` index leading with its filter column, so
  `WHERE created_at < cursor ORDER BY created_at DESC LIMIT n` is an index
  scan.
- **Offset pagination** (admin tables, search) — supported by the same
  indexes plus `COUNT` on the filtered set.

## Seeding

`prisma/seed.ts`, run with `npm run prisma:seed`.

- **Refuses to run when `NODE_ENV=production`.**
- **Idempotent** — fixed UUID constants and `upsert`, so re-running updates
  rather than duplicates. Verified by running it twice and comparing counts.
- **Marked** — every seeded text field carries a `[dev-seed]` marker.
- **No production credentials** — one well-known development password,
  printed on completion rather than hidden. The stored hash is an explicit
  placeholder until Phase 3 introduces Argon2id.
- Counters are **recomputed from the seeded rows** rather than hand-written,
  so they cannot drift from the data.

Content mirrors the frontend's existing mock fixtures (`src/lib/mock/*`), so a
seeded database renders the same UI the mock services produce today.
