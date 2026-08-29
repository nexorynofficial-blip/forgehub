import {
  AI_CAPABILITIES,
  MODERATION_CATEGORIES,
  type AICapability,
  type AIProvider,
  type CollaboratorCandidate,
  type ContentModerationInput,
  type ContentModerationResult,
  type ModerationCategory,
  type ModerationVerdict,
  type ProjectCandidate,
  type ProjectSummaryInput,
  type ProjectSummaryResult,
  type Recommendation,
  type RecommendationInput,
  type RecommendationResult,
  type TagSuggestionInput,
  type TagSuggestionResult,
} from "./ai.types.js";

/**
 * The default provider: deterministic heuristics, no network, no dependency.
 *
 * TRD §27 lists four kinds of provider — *"OpenAI, Anthropic, Google, Local
 * models"* — and this is the local one. It exists for the same reason
 * `ConsoleEmailProvider` does: the abstraction has to be runnable, testable,
 * and demonstrably swappable before any vendor is chosen, and a seam that
 * cannot run is not a seam that has been verified.
 *
 * **It is a heuristic, and it says so.** Every result it returns is
 * computable by hand from its input. It performs no inference and makes no
 * claim to. `generateProjectSummary` is extractive precisely so it cannot
 * invent a fact; `moderateContent` matches terms and is advisory only. Two
 * consequences follow and both are deliberate:
 *
 *   - Its output is **stable across runs**, which is what lets
 *     `tests/ai-unit.test.ts` assert exact values rather than shapes.
 *   - It must **not** be mistaken for a content classifier. See
 *     `moderateContent` below.
 *
 * Swapping in a real model means adding a sibling file and one `case` in
 * `index.ts`. Nothing else in the codebase learns about it.
 */

/* ── Shared text helpers ─────────────────────────────────────────────────── */

/** Words that carry no topical signal, so they never become tags. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
  "we",
  "us",
  "not",
  "all",
  "any",
  "more",
  "most",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "also",
  "about",
  "over",
  "under",
]);

const WORD_PATTERN = /[a-z0-9][a-z0-9+#.-]*/g;

/** Lowercased word tokens. Keeps `c++`, `node.js`, and `c#` intact. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

/**
 * Splits into sentences on terminal punctuation followed by whitespace.
 *
 * Intentionally simple: it is used only to find a clean truncation point, so
 * an abbreviation that fools it costs a slightly shorter summary and nothing
 * else.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Rounds to three decimals so scores compare and serialize predictably. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Clamps into `[0, 1]`. */
function unit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* ── Project summaries ───────────────────────────────────────────────────── */

const DEFAULT_SUMMARY_LENGTH = 280;

/**
 * Takes whole sentences from the front of the description until the next one
 * would exceed the budget; falls back to a word-boundary truncation when even
 * the first sentence is too long, and to the title when there is no
 * description at all.
 */
function summarize(input: ProjectSummaryInput): string {
  const budget = Math.max(1, input.maxLength ?? DEFAULT_SUMMARY_LENGTH);
  const description = input.description.trim();
  const source = description.length > 0 ? description : input.title.trim();

  if (source.length === 0) return "";
  if (source.length <= budget) return source;

  const parts = sentences(source);
  let summary = "";

  for (const sentence of parts) {
    const candidate = summary.length === 0 ? sentence : `${summary} ${sentence}`;
    if (candidate.length > budget) break;
    summary = candidate;
  }

  if (summary.length > 0) return summary;

  // The first sentence alone overruns the budget — cut at a word boundary and
  // mark the cut, so a caller never renders a word sliced in half.
  const hardCut = source.slice(0, budget);
  const lastSpace = hardCut.lastIndexOf(" ");
  const trimmed = (lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut).replace(
    /[\s.,;:!?-]+$/,
    "",
  );

  return `${trimmed}…`;
}

/* ── Content moderation ──────────────────────────────────────────────────── */

/**
 * Illustrative indicator terms, not a content policy.
 *
 * Kept short, plain, and obviously incomplete. A real deployment replaces
 * this provider rather than extending this table — growing it here would
 * build exactly the brittle keyword filter that a hosted classifier exists to
 * avoid, and would put a slur list in version control to no benefit.
 */
const INDICATORS: Readonly<Record<ModerationCategory, readonly string[]>> = {
  spam: ["buy now", "click here", "free money", "work from home", "crypto giveaway"],
  harassment: ["idiot", "loser", "shut up", "nobody likes you"],
  violence: ["kill you", "hunt you down", "beat you up"],
  self_harm: ["kill myself", "end my life", "want to die"],
};

/**
 * Any match at all earns `review`; only a strong score earns `reject`.
 *
 * There is deliberately no third threshold. A keyword table is not confident
 * enough to clear text on a near-miss, so the floor for a match is the
 * verdict that asks a human to look.
 */
const REJECT_SCORE = 0.67;

function moderate(text: string): ContentModerationResult {
  const haystack = text.toLowerCase();
  const matched: ModerationCategory[] = [];
  let hits = 0;

  for (const category of MODERATION_CATEGORIES) {
    const terms = INDICATORS[category];
    const found = terms.filter((term) => haystack.includes(term)).length;
    if (found > 0) {
      matched.push(category);
      hits += found;
    }
  }

  if (matched.length === 0) {
    return { verdict: "allow", score: 0, categories: [] };
  }

  // Categories dominate hit count: text tripping two different categories is
  // a stronger signal than the same phrase appearing twice.
  const score = unit(matched.length / MODERATION_CATEGORIES.length + (hits - 1) * 0.1);

  const verdict: ModerationVerdict = score >= REJECT_SCORE ? "reject" : "review";

  return { verdict, score: round(score), categories: matched };
}

/* ── Tag suggestions ─────────────────────────────────────────────────────── */

const DEFAULT_TAG_LIMIT = 5;
const MIN_TAG_LENGTH = 3;

function suggestTagsFrom(input: TagSuggestionInput): readonly string[] {
  const limit = Math.max(1, input.limit ?? DEFAULT_TAG_LIMIT);
  const tokens = tokenize(`${input.title} ${input.description}`);

  if (tokens.length === 0) return [];

  const frequency = new Map<string, number>();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  const vocabulary = input.vocabulary;

  // With a vocabulary, only known tags may be returned — a suggestion the
  // platform has no tag for is not actionable by the caller.
  if (vocabulary !== undefined) {
    const haystack = `${input.title} ${input.description}`.toLowerCase();

    const scored = vocabulary
      .map((tag, index) => {
        const needle = tag.toLowerCase();
        // Multi-word tags ("machine learning") never appear as one token, so
        // they are matched against the raw text instead of the frequency map.
        const weight = needle.includes(" ")
          ? haystack.includes(needle)
            ? 1
            : 0
          : (frequency.get(needle) ?? 0);
        return { tag, index, weight };
      })
      .filter((entry) => entry.weight > 0);

    scored.sort((a, b) => b.weight - a.weight || a.index - b.index);
    return scored.slice(0, limit).map((entry) => entry.tag);
  }

  const derived = [...frequency.entries()]
    .filter(([word]) => word.length >= MIN_TAG_LENGTH && !STOPWORDS.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);

  return derived;
}

/* ── Recommendations ─────────────────────────────────────────────────────── */

const DEFAULT_RECOMMENDATION_LIMIT = 10;
/** Days after which the recency signal has decayed to roughly nothing. */
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Weights for the ARCHITECTURE §11 signals. They sum to 1 so a score is
 * directly interpretable as a fraction of the best possible match.
 */
const PROJECT_WEIGHTS = { relevance: 0.5, engagement: 0.25, recency: 0.15, follow: 0.1 };
const COLLABORATOR_WEIGHTS = { relevance: 0.7, activity: 0.3 };

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const left = new Set(a.map((value) => value.toLowerCase()));
  let shared = 0;
  for (const value of new Set(b.map((entry) => entry.toLowerCase()))) {
    if (left.has(value)) shared += 1;
  }
  return shared / left.size;
}

/** Exponential decay: 1.0 today, 0.5 at the half-life, approaching 0 after. */
function recency(createdAt: Date, now: Date): number {
  const days = (now.getTime() - createdAt.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return 1;
  return unit(Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

/** Normalizes a count against the largest in the same candidate set. */
function normalized(value: number, max: number): number {
  if (max <= 0) return 0;
  return unit(value / max);
}

function rank(scored: readonly Recommendation[], limit: number): RecommendationResult {
  const ordered = [...scored]
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);

  return { recommendations: ordered };
}

function recommendProjectsFrom(
  input: RecommendationInput<ProjectCandidate>,
): RecommendationResult {
  const limit = Math.max(1, input.limit ?? DEFAULT_RECOMMENDATION_LIMIT);
  const now = input.now ?? new Date();
  const following = new Set(input.viewer.followingIds ?? []);

  // A viewer's own projects are not a recommendation.
  const candidates = input.candidates.filter(
    (candidate) => candidate.ownerId !== input.viewer.id,
  );

  const maxEngagement = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.engagementCount),
    0,
  );

  const scored = candidates.map((candidate): Recommendation => {
    const relevance = overlap(input.viewer.interests, candidate.tags);
    const engagement = normalized(candidate.engagementCount, maxEngagement);
    const fresh = recency(candidate.createdAt, now);
    const follows = following.has(candidate.ownerId) ? 1 : 0;

    const score =
      relevance * PROJECT_WEIGHTS.relevance +
      engagement * PROJECT_WEIGHTS.engagement +
      fresh * PROJECT_WEIGHTS.recency +
      follows * PROJECT_WEIGHTS.follow;

    const reasons: string[] = [];
    if (relevance > 0) reasons.push("shared_tags");
    if (engagement > 0) reasons.push("engagement");
    if (fresh > 0.5) reasons.push("recent");
    if (follows > 0) reasons.push("follows_owner");

    return { id: candidate.id, score: round(unit(score)), reasons };
  });

  return rank(scored, limit);
}

function recommendCollaboratorsFrom(
  input: RecommendationInput<CollaboratorCandidate>,
): RecommendationResult {
  const limit = Math.max(1, input.limit ?? DEFAULT_RECOMMENDATION_LIMIT);
  const following = new Set(input.viewer.followingIds ?? []);

  // Never recommend the viewer to themselves, nor someone they already follow
  // — the point of the feature is discovery.
  const candidates = input.candidates.filter(
    (candidate) => candidate.id !== input.viewer.id && !following.has(candidate.id),
  );

  const maxProjects = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.projectsCount),
    0,
  );

  const scored = candidates.map((candidate): Recommendation => {
    const relevance = overlap(input.viewer.interests, candidate.skills);
    const activity = normalized(candidate.projectsCount, maxProjects);

    const score =
      relevance * COLLABORATOR_WEIGHTS.relevance +
      activity * COLLABORATOR_WEIGHTS.activity;

    const reasons: string[] = [];
    if (relevance > 0) reasons.push("shared_skills");
    if (activity > 0) reasons.push("active_builder");

    return { id: candidate.id, score: round(unit(score)), reasons };
  });

  return rank(scored, limit);
}

/* ── The provider ────────────────────────────────────────────────────────── */

export class LocalAIProvider implements AIProvider {
  readonly name = "local";
  readonly capabilities: readonly AICapability[] = AI_CAPABILITIES;

  generateProjectSummary(input: ProjectSummaryInput): Promise<ProjectSummaryResult> {
    return Promise.resolve({ summary: summarize(input), method: "extractive" });
  }

  /**
   * Advisory only, and never an enforcement decision.
   *
   * PRD §20 lists content moderation among the *potential* AI features, and
   * Phase 11 already owns the actual mechanism: every `ModerationAction`
   * requires a staff actor of sufficient rank and writes an `AuditLog` row in
   * the same transaction. Nothing here writes anything, notifies anyone, or
   * changes a user's status — a `reject` verdict from a keyword table is a
   * suggestion to a human, and treating it as a sanction would put automated
   * punishment behind a term list.
   */
  moderateContent(input: ContentModerationInput): Promise<ContentModerationResult> {
    return Promise.resolve(moderate(input.text));
  }

  suggestTags(input: TagSuggestionInput): Promise<TagSuggestionResult> {
    return Promise.resolve({ tags: suggestTagsFrom(input) });
  }

  recommendProjects(
    input: RecommendationInput<ProjectCandidate>,
  ): Promise<RecommendationResult> {
    return Promise.resolve(recommendProjectsFrom(input));
  }

  recommendCollaborators(
    input: RecommendationInput<CollaboratorCandidate>,
  ): Promise<RecommendationResult> {
    return Promise.resolve(recommendCollaboratorsFrom(input));
  }
}
