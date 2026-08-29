/**
 * AI provider abstraction (BACKEND_PRD.md §20, BACKEND_TRD.md §27,
 * BACKEND_ARCHITECTURE.md §22).
 *
 * All three specifications agree on one mandatory requirement and phrase it
 * three ways:
 *
 *   - PRD §20 — *"AI functionality must be modular"* and *"AI providers must
 *     be replaceable without redesigning the application."*
 *   - TRD §27 — *"AI functionality must use an abstraction layer"* and *"The
 *     application should not depend directly on one provider throughout the
 *     codebase."*
 *   - ARCHITECTURE §22 — *"AI functionality must use an abstraction"*, naming
 *     `AIService` and the five methods this file's `AIProvider` mirrors.
 *
 * What the specifications do **not** do is require any particular feature to
 * ship. PRD §20 lists *"Potential features"*; TRD §27 says *"AI features may
 * include"*; ARCHITECTURE §22 introduces the method list with *"Example"*.
 * The abstraction is the requirement; the features are the illustration.
 *
 * So this file is the contract, and it is deliberately the whole of the
 * public surface: a caller depends on `AIProvider`/`AIService` and never on a
 * concrete provider, which is the property the three specs actually demand.
 *
 * **This is a seam, not an endpoint.** ARCHITECTURE §29 enumerates fifteen
 * API roots and none of them is `/api/v1/ai`, so Phase 12 adds no route, no
 * controller, and no OpenAPI path — `tests/openapi.test.ts` has asserted the
 * absence of an `/ai` path since Phase 11 and still does. The precedent is
 * `ports/notification.port.ts`, which shipped in Phase 4 as a no-op seam and
 * was made live in Phase 9 without one call site changing.
 */

/**
 * The five capabilities ARCHITECTURE §22 names, as a closed union.
 *
 * A provider declares which of these it actually implements rather than
 * throwing at call time, so `AIService` can answer "can you do this?" without
 * attempting the work and a partially-capable provider is a first-class
 * citizen rather than a source of runtime surprises.
 */
export type AICapability =
  | "project_summary"
  | "content_moderation"
  | "tag_suggestion"
  | "project_recommendation"
  | "collaborator_recommendation";

export const AI_CAPABILITIES: readonly AICapability[] = [
  "project_summary",
  "content_moderation",
  "tag_suggestion",
  "project_recommendation",
  "collaborator_recommendation",
];

/**
 * Why a request produced no data.
 *
 * Modelled explicitly rather than as `null` because the four cases are
 * operationally different: a disabled provider is a deployment choice, an
 * unsupported capability is a provider limitation, an error is a fault worth
 * alerting on, and invalid input is the caller's bug. Collapsing them would
 * make an outage indistinguishable from a feature that was switched off.
 */
export type AIUnavailableReason =
  "provider_disabled" | "capability_unsupported" | "provider_error" | "invalid_input";

/**
 * Every `AIService` method returns this rather than throwing.
 *
 * AI is an enrichment, never a correctness dependency: a summary that cannot
 * be generated must not fail the project update that asked for it. This
 * mirrors `EmailService`, which swallows transport failures for the same
 * reason, and `NotificationPort`, whose contract is fire-and-forget.
 */
export type AIResult<T> =
  | { readonly available: true; readonly data: T }
  | { readonly available: false; readonly reason: AIUnavailableReason };

/* ── Project summaries ───────────────────────────────────────────────────── */

export interface ProjectSummaryInput {
  readonly title: string;
  readonly description: string;
  /** Hard ceiling on the returned summary, in characters. */
  readonly maxLength?: number;
}

export interface ProjectSummaryResult {
  readonly summary: string;
  /**
   * `extractive` means every word is drawn verbatim from the input;
   * `abstractive` means the provider generated new text.
   *
   * Carried in the result because the distinction is not cosmetic — an
   * extractive summary cannot hallucinate a fact the description does not
   * contain, and a caller deciding whether to show a summary unreviewed is
   * entitled to know which kind it received.
   */
  readonly method: "extractive" | "abstractive";
}

/* ── Content moderation ──────────────────────────────────────────────────── */

/**
 * Advisory categories. Deliberately coarse and provider-neutral — a richer
 * taxonomy would encode one vendor's label set into the abstraction.
 */
export type ModerationCategory = "spam" | "harassment" | "violence" | "self_harm";

export const MODERATION_CATEGORIES: readonly ModerationCategory[] = [
  "spam",
  "harassment",
  "violence",
  "self_harm",
];

/**
 * `allow` — nothing found. `review` — worth a human's attention.
 * `reject` — the provider is confident.
 *
 * Note there is no `delete`, `ban`, or `suspend`. This type advises; it does
 * not act. Phase 11 owns enforcement and requires a human actor for every
 * moderation action, and nothing in Phase 12 changes that.
 */
export type ModerationVerdict = "allow" | "review" | "reject";

export interface ContentModerationInput {
  readonly text: string;
}

export interface ContentModerationResult {
  readonly verdict: ModerationVerdict;
  /** Confidence in `[0, 1]`, rounded to three decimals. */
  readonly score: number;
  readonly categories: readonly ModerationCategory[];
}

/* ── Tag suggestions ─────────────────────────────────────────────────────── */

export interface TagSuggestionInput {
  readonly title: string;
  readonly description: string;
  /**
   * The tag vocabulary to choose from.
   *
   * Supplied by the caller rather than read from the database, because this
   * layer performs no I/O (see `AIProvider`). When omitted the provider may
   * derive candidates from the text itself.
   */
  readonly vocabulary?: readonly string[];
  /** Maximum tags to return. Providers clamp rather than reject. */
  readonly limit?: number;
}

export interface TagSuggestionResult {
  readonly tags: readonly string[];
}

/* ── Recommendations ─────────────────────────────────────────────────────── */

/**
 * The requesting user's signals.
 *
 * ARCHITECTURE §11 lists the ranking signals this platform recognises —
 * recency, engagement, follow relationships, community membership, project
 * relevance, and user interests — and §11 also says, in the same breath, *"Do
 * not build a complex recommendation engine during the initial backend
 * phase. Create an architecture that can support one later."* This interface
 * is that architecture: it names the signals so a real ranker can consume
 * them, without committing the platform to a learned model.
 */
export interface RecommendationViewer {
  readonly id: string;
  /** Tags/skills the viewer has signalled interest in. */
  readonly interests: readonly string[];
  /** Ids the viewer already follows — used to avoid recommending them again. */
  readonly followingIds?: readonly string[];
}

export interface ProjectCandidate {
  readonly id: string;
  readonly ownerId: string;
  readonly tags: readonly string[];
  /**
   * Whatever the caller counts as engagement (likes, stars, updates).
   *
   * Left uninterpreted on purpose: the abstraction should not need to know
   * which column a phase happened to denormalize.
   */
  readonly engagementCount: number;
  readonly createdAt: Date;
}

export interface CollaboratorCandidate {
  readonly id: string;
  readonly skills: readonly string[];
  /** Shipped projects — an activity signal, not a quality judgement. */
  readonly projectsCount: number;
}

export interface RecommendationInput<TCandidate> {
  readonly viewer: RecommendationViewer;
  readonly candidates: readonly TCandidate[];
  readonly limit?: number;
  /** Reference time, so scoring stays deterministic and testable. */
  readonly now?: Date;
}

export interface Recommendation {
  readonly id: string;
  /** Relevance in `[0, 1]`, rounded to three decimals. */
  readonly score: number;
  /**
   * Why this was recommended, as stable machine-readable keys.
   *
   * Present because an unexplainable recommendation is not reviewable: an
   * operator comparing two providers needs to see what each one weighted.
   */
  readonly reasons: readonly string[];
}

export interface RecommendationResult {
  readonly recommendations: readonly Recommendation[];
}

/* ── The provider contract ───────────────────────────────────────────────── */

/**
 * What a provider implements. One method per ARCHITECTURE §22 capability.
 *
 * Two rules bind every implementation:
 *
 *  1. **No I/O against this application's own data.** A provider receives
 *     everything it needs as an argument. Repositories remain the only Prisma
 *     callers (ARCHITECTURE §8), and a provider that queried the database
 *     would put a network round-trip behind an interface callers reasonably
 *     assume is cheap.
 *  2. **Deterministic for a given input, or explicitly not.** The local
 *     provider is deterministic, which is what makes it exhaustively
 *     testable; a remote model provider will not be, and that difference
 *     belongs in its documentation rather than hidden behind the interface.
 *
 * A provider may throw — `AIService` is the layer that catches.
 */
export interface AIProvider {
  /** Identifies the provider in logs and health output. */
  readonly name: string;
  /** The subset of `AI_CAPABILITIES` this provider actually implements. */
  readonly capabilities: readonly AICapability[];

  generateProjectSummary(input: ProjectSummaryInput): Promise<ProjectSummaryResult>;
  moderateContent(input: ContentModerationInput): Promise<ContentModerationResult>;
  suggestTags(input: TagSuggestionInput): Promise<TagSuggestionResult>;
  recommendProjects(
    input: RecommendationInput<ProjectCandidate>,
  ): Promise<RecommendationResult>;
  recommendCollaborators(
    input: RecommendationInput<CollaboratorCandidate>,
  ): Promise<RecommendationResult>;
}
