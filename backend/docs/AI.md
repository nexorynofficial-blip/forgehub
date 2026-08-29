# AI

Phase 12. The AI abstraction layer — `BACKEND_PRD.md` §20, `BACKEND_TRD.md`
§27, `BACKEND_ARCHITECTURE.md` §22.

`ARCHITECTURE.md` §38 names this phase in one word: **AI**. What follows is
what the three specifications actually require, what they explicitly leave
optional, and what this phase therefore did and did not build.

## Where this scope came from

**There is no dedicated backend Phase 12 prompt document, and none was
written to fill the gap.**

`ARCHITECTURE.md` §39 instructs each backend phase to read the _"Relevant
BACKEND phase document"_, but `ForgeHub_ClaudeCode_Prompts/` contains only
`FRONTEND/01–12`; no backend phase documents exist for any phase. So unlike
Phases 10 and 11, this phase had no numbered rulings to work from, and the
scope below was derived entirely from the authoritative sources:

| Source                             | Supplies                                                |
| ---------------------------------- | ------------------------------------------------------- |
| `BACKEND_ARCHITECTURE.md` §38      | that Phase 12 is **AI**                                 |
| `BACKEND_PRD.md` §20               | modularity, provider replaceability, potential features |
| `BACKEND_TRD.md` §27               | the abstraction layer, provider kinds                   |
| `BACKEND_ARCHITECTURE.md` §22      | `AIService` and the five capability methods             |
| `BACKEND_ARCHITECTURE.md` §29      | the API root list — which contains no `/ai`             |
| `BACKEND_ARCHITECTURE.md` §11, §23 | ranking signals; background jobs as a future concern    |

This derivation was reviewed and accepted. Recording it here is the point:
the reasoning is auditable, and no invented specification stands behind any
decision in this document.

## What is required, and what is illustration

This distinction drives every decision below, so it comes first.

All three sources state the **same single mandatory requirement**, and each
states it with "must":

| Source                        | Requirement                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `BACKEND_PRD.md` §20          | _"AI functionality **must** be modular"_ · _"AI providers **must** be replaceable"_              |
| `BACKEND_TRD.md` §27          | _"AI functionality **must** use an abstraction layer"_ · not _"depend directly on one provider"_ |
| `BACKEND_ARCHITECTURE.md` §22 | _"AI functionality **must** use an abstraction"_ — names `AIService` and five methods            |

The **features** are named in all three, and in all three they are optional
by their own wording:

- PRD §20 — _"**Potential** features:"_
- TRD §27 — _"AI features **may** include:"_
- ARCHITECTURE §22 — _"**Example**: AIService / Methods: …"_

So the abstraction is the deliverable and the features are the illustration.
Phase 12 builds the abstraction, implements all five illustrated capabilities
behind it, and ships no feature into another module's behaviour.

## No endpoint, and why

**Phase 12 adds no route, no controller, and no OpenAPI path.**

`ARCHITECTURE.md` §29 enumerates the platform's API roots. There are fifteen:

```
/auth  /users  /profiles  /projects  /posts  /comments  /communities
/messages  /notifications  /search  /achievements  /moderation  /admin
/uploads
```

`/api/v1/ai` is not among them. §29 is the same list that decided Phase 11
would be two modules rather than one, so it is treated the same way here: the
absence is a specification, not an omission. TRD §12's endpoint list names no
AI endpoint either, and the shipped frontend calls none.

`tests/openapi.test.ts` has asserted the absence of an `/ai` path since Phase
11, under the comment _"Phase 12+ boundaries, asserted so a stray path cannot
appear unnoticed."_ **That test is unchanged and still passes.** It was left
untouched deliberately: it is the thing that would have caught this phase
inventing a surface, and a phase that edits its own tripwire has not passed
it.

The precedent for shipping a seam before its consumers is
`ports/notification.port.ts`, which shipped in Phase 4 as a no-op, sat unused
for four phases, and was made live in Phase 9 without a single call site
changing.

## The shape

Mirrors `integrations/email/` exactly — a second abstraction shape for the
same problem would be a second architecture.

```
src/integrations/ai/
  ai.types.ts          The contract: AIProvider, AIResult, capability I/O types
  ai.service.ts        AIService — the class §22 names, with the five §22 methods
  local.provider.ts    Deterministic heuristics; no network, no dependency
  disabled.provider.ts The off switch; declares no capabilities
  index.ts             Composition root — the only place that picks a provider
```

| Email                     | AI                     |
| ------------------------- | ---------------------- |
| `EmailProvider`           | `AIProvider`           |
| `EmailService`            | `AIService`            |
| `ConsoleEmailProvider`    | `LocalAIProvider`      |
| `EMAIL_PROVIDER` env enum | `AI_PROVIDER` env enum |
| `switch` in `index.ts`    | `switch` in `index.ts` |

Adding OpenAI, Anthropic, Google, or a self-hosted model is one new file, one
new `case`, and one new enum value. Nothing outside this directory changes —
which is the property PRD §20 asks for by name.

## The five capabilities

Exactly the methods `ARCHITECTURE.md` §22 lists.

| Method                     | Capability                    | Returns                              |
| -------------------------- | ----------------------------- | ------------------------------------ |
| `generateProjectSummary()` | `project_summary`             | summary + `extractive`/`abstractive` |
| `moderateContent()`        | `content_moderation`          | verdict, score, categories           |
| `suggestTags()`            | `tag_suggestion`              | tags drawn from a vocabulary         |
| `recommendProjects()`      | `project_recommendation`      | ranked ids with reasons              |
| `recommendCollaborators()` | `collaborator_recommendation` | ranked ids with reasons              |

### Three guarantees on every method

1. **It never throws.** A provider fault becomes
   `{ available: false, reason: "provider_error" }`. AI enriches; it is never
   load-bearing, and a summariser outage must not fail the write that asked
   for a summary. `EmailService` swallows transport failures for the same
   reason, and `NotificationPort` is fire-and-forget on the same principle.

2. **Unsupported capabilities never reach the provider.** The capability
   check runs first, so a partially-implemented provider answers
   `capability_unsupported` rather than throwing from a stub. The check also
   runs _before_ input validation, so "AI is switched off" is never masked by
   a complaint about the payload.

3. **No user content is ever logged.** A failure records the provider, the
   capability, and the error — never the text that was summarised, moderated,
   or tagged. This is the rule `ConsoleEmailProvider` follows for reset tokens
   (TRD §30), and it matters more here: the text passed to `moderateContent`
   is by definition the most sensitive on the platform. `tests/ai-unit.test.ts`
   pins it by failing a provider on a known string and asserting that string
   never appears in the log call.

### Why a result envelope instead of `null`

`AIResult<T>` distinguishes four reasons for an empty answer:

| Reason                   | Means                          |
| ------------------------ | ------------------------------ |
| `provider_disabled`      | a deployment turned AI off     |
| `capability_unsupported` | this provider does not do that |
| `provider_error`         | a fault worth alerting on      |
| `invalid_input`          | the caller's bug               |

Collapsing these into `null` would make an outage indistinguishable from a
feature that was deliberately switched off.

## The local provider

The default. TRD §27 lists four kinds of provider — _"OpenAI, Anthropic,
Google, Local models"_ — and this is the local one. It exists for the same
reason `ConsoleEmailProvider` does: a seam that cannot run has not been
verified.

**It is a heuristic and it says so.** Every result is computable by hand from
its input. It performs no inference and claims none. Two consequences, both
deliberate:

- Output is **stable across runs**, which is what lets `tests/ai-unit.test.ts`
  assert exact values rather than shapes. If a number there changes, the
  heuristic changed.
- It must not be mistaken for a model. See the moderation warning below.

| Capability      | Heuristic                                                                        |
| --------------- | -------------------------------------------------------------------------------- |
| Summary         | extractive — whole sentences from the front, word-boundary cut, `…` marks it     |
| Moderation      | indicator-term matching over four coarse categories                              |
| Tags            | frequency ranking against the caller's vocabulary, or stopword-filtered keywords |
| Recommendations | weighted ARCHITECTURE §11 signals: relevance, engagement, recency, follows       |

The summary is extractive **on purpose**: every word comes from the input, so
it cannot state a fact the description does not contain. The result carries
`method: "extractive"` because a caller deciding whether to display a summary
unreviewed is entitled to know which kind it received.

### Recommendation weights

`ARCHITECTURE.md` §11 lists the ranking signals and, in the same breath, says
_"Do not build a complex recommendation engine during the initial backend
phase. Create an architecture that can support one later."_ This is that
architecture — the signals are named so a real ranker can consume them,
without committing the platform to a learned model.

```
projects:      relevance 0.50 · engagement 0.25 · recency 0.15 · follows 0.10
collaborators: relevance 0.70 · activity 0.30
```

Weights sum to 1, so a score reads directly as a fraction of the best possible
match. Recency is exponential decay with a 30-day half-life. Ties break by id
so paging is stable. A viewer's own projects are never recommended to them,
and neither is a collaborator they already follow — the feature is discovery.

Every recommendation carries `reasons` (`shared_tags`, `engagement`, `recent`,
`follows_owner`, `shared_skills`, `active_builder`). An unexplainable
recommendation is not reviewable, and an operator comparing two providers
needs to see what each weighted.

## Moderation is advisory. It does not moderate.

**`moderateContent()` returns an opinion. It is not an enforcement mechanism,
and nothing in Phase 12 wires it to one.**

Phase 11 owns enforcement, and the rules there are unchanged: every
`ModerationAction` requires a staff actor of strictly higher rank than the
target, and writes an `AuditLog` row in the same transaction. This phase adds
no automated path around that.

The result type is deliberately incapable of acting. It carries a verdict, a
score, and categories — no user id, no action verb, no target. The verdict
vocabulary is `allow` / `review` / `reject`, with no `delete`, `ban`, or
`suspend` in it.

A legitimate use is ordering a review queue or warning an author before they
post. Using a keyword table's confidence score to remove content or sanction
an account without human review would be automated punishment behind a term
list, and the local provider's own indicator set is short, plain, and
obviously incomplete precisely so it cannot be mistaken for a content policy.

## Purity: the seam performs no I/O

No file in `integrations/ai/` imports Prisma, Redis, or a HTTP client. A
provider receives everything it needs as an argument.

This is not tidiness. Two things follow from it:

- **Repositories remain the only Prisma callers** (ARCHITECTURE §8). A
  provider that queried the database would be a second, unaudited read path.
- **Ranking cannot widen visibility.** The caller supplies the candidates, so
  whatever visibility rules produced that list still bound the result. A
  ranker that fetched its own candidates could surface a private project
  through a recommendation, which is exactly the class of leak Phases 5–10
  spent their visibility rules preventing.

It also means the whole layer is unit-testable with no database, which is why
`tests/ai-unit.test.ts` runs in ~100 ms.

## Configuration

```bash
AI_PROVIDER=local      # deterministic heuristics, no network, no key (default)
AI_PROVIDER=disabled   # every capability reports itself unavailable
```

Defaulted, so a fresh checkout has a working seam and no existing `.env`
breaks. `parseEnv` rejects any other value at boot rather than at the first
call that happens to need a summary.

### There is deliberately no `AI_API_KEY`

TRD §13 lists _"AI API keys"_ among the secrets that must never be committed.
The way to honour that while no provider needs one is to not invent the
variable: an unused key in `.env.example` is somewhere real credentials get
pasted. It arrives with the provider that requires it, as a `secret()` like
every other credential in `config/env.ts`.

## What this phase did not do

- **No API endpoint** — ARCHITECTURE §29 names no `/ai` root. Above.
- **No schema change.** No model, no column, no enum member, no migration.
  Migration count is still **2**. Nothing here persists anything; there is no
  `Project.summary` column and inventing one would be a schema change no
  specification asks for.
- **No dependency.** No `openai`, no `@anthropic-ai/sdk`, no HTTP client.
  TRD §27 names providers as examples, not requirements, and the local
  provider needs none.
- **No background jobs.** ARCHITECTURE §23 lists _"AI processing"_ among the
  operations that _"should use background jobs"_, and `src/jobs/` is still the
  empty directory earlier phases left. This is a **known gap**, recorded
  below rather than closed, because closing it means adding BullMQ and a
  worker process — a dependency and a deployment change that no Phase 12
  requirement authorises. It becomes real when a provider with latency and a
  per-call bill arrives; the local provider is synchronous and free.
- **No changes to any completed phase.** `ai_recommended` still aliases
  `recommended` in the feed (Phase 6, decision J5). Rewiring it through
  `AIService` would change a shipped endpoint's behaviour, and §11's "do not
  build a recommendation engine" is still in force. The seam it would need
  now exists.

## Known limitations

- **The seam has no callers yet.** Deliberate, and the same position
  `notification.port.ts` occupied from Phase 4 to Phase 9. The abstraction is
  the requirement; wiring a capability into a module is a behaviour change to
  that module and needs its own authorisation.
- **The local provider is not a model.** It cannot summarise abstractively,
  its moderation is keyword matching, and its recommendations are a weighted
  sum. It is a correct, honest, testable placeholder — not a substitute for a
  real provider.
- **`suggestTags` does not read the tag table.** The vocabulary is supplied by
  the caller, per the no-I/O rule. A caller wanting platform-wide tags passes
  them in.

## Known future integration points

Recorded rather than built. Each is deliberately deferred, and each needs its
own authorisation because each changes something this phase may not.

### Background AI processing (ARCHITECTURE §23)

§23 lists _"AI processing"_ among the operations that _"should use background
jobs"_, and `src/jobs/` is still the empty directory earlier phases left.

Closing this means BullMQ, a Redis queue, a worker process, and a new Docker
service — a dependency and deployment change no current requirement
authorises. It is **deferred, not overlooked**. It becomes real when a
provider with latency and a per-call bill arrives; the local provider is
synchronous, free, and finishes in microseconds, so there is nothing yet for
a queue to protect.

The seam is already shaped for it: `AIService` methods are `async` and return
a result envelope, so moving a call behind a queue changes the caller's
timing, not its types.

### A hosted provider's error payloads

`AIService` logs `{ err, provider, capability }` and never the input, and both
current providers throw content-free errors — `DisabledAIProvider` names only
the capability, and `LocalAIProvider` does not throw at all.

A hosted SDK is different: some embed the request body in the error they
raise, which would put user text into `err` and therefore into the log
stream. Pino's redaction (TRD §30) covers credential-shaped keys, not
arbitrary prose, so it would not catch this. **Whoever adds the first remote
provider must sanitise its errors before they reach `logger.error`** — most
simply by catching inside the provider and re-throwing a message it controls.

### Wiring a capability into a module

The five capabilities exist and are unused. Connecting one — summaries on
projects, tag suggestions on create, `ai_recommended` in the feed — is a
behaviour change to that module and needs its own decision, not an assumption
that the capability's existence implies its use.

## Tests

`tests/ai-unit.test.ts` — 46 tests, no database.

| Group                | Covers                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| Provider replacement | identical consumer code across two unrelated providers; interface-only needs |
| The abstraction      | five §22 methods present, never throws, no content logged, capability gating |
| `DisabledAIProvider` | declares nothing, reports `provider_disabled`, still never throws            |
| Summaries            | passthrough, title fallback, sentence boundary, word-boundary cut, budgets   |
| Moderation           | clean text, single/multi category, reject threshold, `[0,1]` bound, shape    |
| Tags                 | vocabulary-only output, multi-word entries, casing, stopwords, limit         |
| Recommendations      | self-exclusion, relevance, decay, follow boost, bounds, tie-break, limit     |
| `AI_PROVIDER`        | default, accepted values, refusal of an unimplemented provider               |
