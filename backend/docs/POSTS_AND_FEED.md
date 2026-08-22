# Posts, comments, and the feed

Decisions behind `src/modules/posts/` (Backend Phase 6). Read alongside
BACKEND_PRD.md §8–9, BACKEND_TRD.md §5 and §8, and BACKEND_ARCHITECTURE.md §11.

## What Phase 6 is

The three source documents name this phase three different things —
ARCHITECTURE §38 calls it **Feed**, TRD §4 lists **`posts`** and **`comments`**
as separate modules, and `src/modules/README.md` assigned both to Phase 6.

The frontend settles it. The shipped surface is `/feed`, and it is one
component tree — `FeedList` → `PostCard` → `CommentSection` — behind one
`feed-service.ts`. Posts without a feed is a module with no consumer; a feed
without posts is impossible. So Phase 6 is **posts + comments + feed**, in one
module.

## Module boundaries

One `posts/` module for the whole aggregate: `Post`, `PostMedia`, `Poll`,
`PollOption`, `PollVote`, `Comment`, `PostLike`, `CommentLike`, `Bookmark`.

TRD §4 lists `posts` and `comments` separately, and this deviates deliberately.
A comment has no meaning outside a post, every comment write authorizes against
the post's gate, and splitting them would mean two modules re-deriving one
access decision — the same argument that kept the project aggregate together in
Phase 5.

Internally: **one repository** for the root and every child, with a **service
per sub-domain** (`posts`, `comments`, `engagement`, `feed`) where the business
rules genuinely differ.

## The single gate

`posts.service.loadVisiblePost(postId, viewer)` is the **only** entry point to a
post. Every read, every write, every comment, like, bookmark, and vote goes
through it.

That is what makes the privacy rules hold everywhere without being restated. A
child route that loaded the post itself would be one refactor away from
forgetting the block check, and a blocked viewer reaching a post's comment
thread through a side door would defeat the rule entirely.

## Visibility

`post.visibility.ts` — pure functions, tested without a database.

| #   | Condition                                        | Direct read | In the feed |
| --- | ------------------------------------------------ | ----------- | ----------- |
| 1   | Soft-deleted                                     | `not_found` | omitted     |
| 2   | Author has blocked the viewer                    | `not_found` | omitted     |
| 3   | Viewer is the author                             | `full`      | included    |
| 4   | Published into a community                       | `not_found` | **omitted** |
| 5   | Viewer is moderator / community / platform admin | `full`      | public only |
| 6   | `public`                                         | `full`      | included    |
| 7   | `unlisted`                                       | `full`      | **omitted** |
| 8   | `private`                                        | `not_found` | omitted     |

Four things worth stating plainly:

- **Every closed gate is a 404, never a 403.** A 403 confirms the post exists,
  and for a blocked viewer it announces the block.
- **Blocking outranks the admin role**, carrying the Phase 4/5 precedent
  forward. Moderation tooling is a Phase 11 surface with its own audited
  endpoints; it should not arrive by accident through a post read.
- **Rule 4 sits before the admin check on purpose.** An admin cannot stand in
  for a community-membership test this phase is unable to perform.
- **An admin's feed is not a moderation queue.** They may _read_ a private post
  by id, but the shared feed never mixes other people's private content into
  it — `isPostListable` returns public-only for them.

The listing filter is expressed twice: once as the pure `isPostListable`, once
as SQL in `listVisibilityWhere`. The pure function is what the unit tests pin
the rules to; the SQL is what stops a hidden post consuming a page slot or
inflating `total`. They must agree branch for branch.

## Community posts are excluded, not assumed public

`Post.communityId` exists and the seed uses it, but Phase 7 owns `Community`.
Phase 6 therefore:

- **refuses `communityId` on create** — the field is absent from every write
  schema, so it is stripped rather than honoured;
- **excludes community posts from every listing**, for everyone including their
  author;
- **treats a community post as author-only** on a direct read;
- **never projects `communityId`** into a response.

The alternative — treating them as public until Phase 7 lands — would leak
private-community content the moment communities became real. The visible cost
is that the seeded `code` post, which carries a `communityId`, does not appear
in the Phase 6 feed. That is the correct behaviour, not a regression.

## Comments

**One reply level.** `Comment.parentCommentId` is an adjacency list, the shipped
UI renders a flat thread, and DATABASE.md warns against an over-complicated
comment architecture. A reply to a reply is a **422 that names the real
parent**, so a client can retry against the thread root rather than guess.

### Tombstones

A soft-deleted comment that **still has replies is kept in the response** with
its content replaced by `[deleted]`, its author dropped to `null`, its
`authorId` blanked, and its like count zeroed.

This is not decoration. `Comment.parent` has `onDelete: Cascade`, which fires
only on a **hard** delete — soft-deleting a parent leaves its replies in place.
Dropping the parent from the response would make those replies unreachable
children of a comment that no longer appears. A deleted comment with _no_
replies is filtered out entirely, because nothing depends on it.

The tombstone is built by construction in `post.view.ts`, not by blanking
fields on a full view, so a column added later cannot leak through it.

### Who may do what

| Action | Comment author | Post author | Admin |
| ------ | -------------- | ----------- | ----- |
| Edit   | ✓              |             |       |
| Delete | ✓              | ✓           | ✓     |

Editing is author-only — deliberately narrower than deletion. PRD §9 requires
moderation, and moderation _removes_ content; it does not rewrite it in someone
else's voice. The post's author gets deletion because a thread on your own post
is yours to keep clean.

## `commentsCount`

Defined exactly as `prisma/seed.ts` recomputes it: **replies included,
soft-deleted excluded**. Diverging would make the seed's own counters disagree
with the API — the mistake Phase 5 had to correct for `projectsCount`.

## Counters and concurrency

Four counters, each moved inside the transaction that earns it:

| Counter                | Trigger                      | Arbiter                      |
| ---------------------- | ---------------------------- | ---------------------------- |
| `Post.likesCount`      | `PostLike` insert/delete     | composite PK → `P2002`       |
| `Post.commentsCount`   | comment create / soft-delete | gated on rows changing       |
| `Comment.likesCount`   | `CommentLike` insert/delete  | composite PK                 |
| `PollOption.voteCount` | `PollVote` insert            | `@@unique([pollId, userId])` |

**Every one is an atomic increment, not a read-modify-write.** That is why none
of them needs the explicit row lock Phase 5's `progressPercent` required — the
one genuine concurrency defect of that phase does not recur here.

`Bookmark` has no counter at all: there is no `bookmarksCount` column, and a
public tally would turn a private save into a signal.

### The poll race worth knowing about

`PollVote` is unique on **`(pollId, userId)`**, not `(optionId, userId)`. Two
simultaneous votes by the same user for two _different_ options are therefore a
race the database settles: exactly one commits, the other raises `P2002`. The
increment lives inside that same transaction, so the losing vote cannot inflate
a tally on its way out. `posts-concurrency.test.ts` fires exactly this.

Votes are final — there is no update path — which matches the shipped
`PollVoter`, which disables itself after one choice.

## The feed

ARCHITECTURE §11 is explicit that this phase must not build a recommendation
engine, so every filter is a query over an indexed column and nothing more. The
ranking _signals_ §11 lists — recency, engagement, follow relationships — are
each represented; combining them into a learned score is Phase 12.

| Filter           | Order                                 | Index                                          |
| ---------------- | ------------------------------------- | ---------------------------------------------- |
| `latest`         | `createdAt DESC`                      | `posts(visibility, deletedAt, createdAt DESC)` |
| `trending`       | `likesCount DESC`                     | `posts(deletedAt, likesCount DESC)`            |
| `popular_today`  | `likesCount DESC`, last 24h           | same                                           |
| `following`      | `createdAt DESC`, followed authors    | relation filter                                |
| `recommended`    | `commentsCount DESC, likesCount DESC` | —                                              |
| `ai_recommended` | **aliases `recommended`**             | —                                              |

`ai_recommended` aliases rather than 501s because the chip is already on screen
in the shipped `FeedFilters`; returning an error for a filter the UI offers
would be a worse answer than a deterministic one. `recommended` uses
comments-then-likes, which is precisely what `feed-service.ts` does for that
filter. The weighted `likes + 3*comments` form the frontend uses for
`ai_recommended` is not expressible in an indexed `orderBy` and would need a
sort over the whole table.

**`following` for an anonymous caller returns nothing**, not "latest". Silently
substituting a different feed than the one requested would be worse than an
empty one.

Every filter has `id` as its final tiebreaker so cursor paging is stable —
without a unique last key, two posts with equal counts could straddle a page
boundary and be returned twice or skipped.

### `GET /feed/new-count`

Backs the shipped "new posts" pill, which currently calls a placeholder that
returns a hard-coded number. One indexed `COUNT` against **the same filter and
the same visibility scope** the caller is looking at — a count taken against a
wider scope would promise rows the feed then refuses to return.

## Response shapes

`post.view.ts` is the sole chokepoint. Three columns are selected by the
repository and never projected: `deletedAt` (emitting it would distinguish
"soft-deleted" from "never existed", which is what the 404 exists to erase),
`communityId` (see above), and the author of a tombstoned comment.

Two shapes deserve note because they are _not_ what a backend would invent:

- **`mediaUrls` is a flat `string[]`**, because `post-type-content.tsx` maps
  over exactly that. The structured `media[]` is served alongside it.
- **`poll` carries no `id` in the frontend's type** and votes by `option.id`,
  because that is all `PollVoter` has in hand. `id`, `votedOptionId`, and
  `isClosed` are additive.

The feed returns `{ items, nextCursor, total }` — the frontend's
`Paginated<T>` — not the offset `pagination` envelope, because `FeedList`
drives `useInfiniteQuery` with `getNextPageParam: (p) => p.nextCursor`.

`author` is `toUserSummary` from Phase 4, which _is_ the frontend's `PostAuthor`
field for field. Phase 4 built it against that type precisely so this phase
would not need a second one.

## Media is protocol-restricted

Media URLs must be `http` or `https`. `z.string().url()` accepts
`javascript:alert(1)` — a syntactically valid URL — and media URLs are rendered
into the DOM.

This is deliberately **stricter than Phase 5's `gallery`**, which had to stay
permissive because the shipped project fixtures store opaque ids like `gal_1`.
The post fixtures use empty `mediaUrls` arrays, so nothing here forces the
looser rule, and the safer default wins.

## Mentions

`@handle` mentions are parsed at write time, resolved against real accounts,
and announced through `NotificationPort`. **No `Mention` row is persisted** —
the schema is frozen for this phase and has no such model, and Phase 9 owns
delivery and can persist whatever it needs from the port event.

The parser mirrors `usernameSchema` exactly (3–30 chars of `[a-z0-9._]`),
because parsing a wider set would produce candidates that can never resolve.
Trailing dots and underscores are trimmed, so "ask @ava." mentions `ava`;
`user@example.com` mentions nobody, because the character before `@` must not
be part of a handle. Mentions are capped per post so one post cannot notify an
unbounded audience.

## The notification port

`PortNotificationType` gains `comment`, `reply`, and `mention` — all
single-recipient, which is what this port is. `like` was already added in
Phase 5 and is reused for post likes.

`NotificationEvent.entityType` gains `post` and `comment`.

## Posts and projects stay separate

Creating or editing a Phase 5 `ProjectUpdate` does **not** create a `Post`, and
vice versa. `ProjectUpdate` is the project's own record; a post is social. A
post may _name_ a project through `projectId`, but naming it never writes to it
— that separation is what keeps the changelog independent of the feed.

The attribution is validated: the project must exist, be undeleted, and not be
someone else's private project. A private project owned by someone else is
refused with the same "does not exist" message it would give for an unknown id,
so attribution cannot be used to probe for private projects.

## What Phase 6 deliberately does not do

- **No Share/Repost.** PRD §8 lists "Share", but no model exists and inventing
  a repost table is a schema change. On comparable platforms sharing is a
  client-side link copy; this is an explicit deferral, not an oversight.
- **No communities.** See above.
- **No realtime.** TRD §21 lists no post socket events, no shipped component
  subscribes, and the frontend's own comment assigns push to Phase 9. The
  `new-count` endpoint backs the existing poll instead.
- **No notification rows.** The port is called; Phase 9 delivers.
- **No uploads.** Media is accepted as a URL; Cloudinary is Phase 11.
- **No restore.** Soft delete has no inverse in this phase.
- **No search.** The feed filters on indexed columns; full-text is Phase 10.
- **No achievement awarding and no XP mutation.** `first-post` is a seeded
  achievement, but the engine is Phase 10.
- **No reports or moderation queue.** An author or admin can delete; reporting
  is Phase 11.
