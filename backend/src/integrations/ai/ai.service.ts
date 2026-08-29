import { logger } from "../../utils/logger.js";
import type {
  AICapability,
  AIProvider,
  AIResult,
  CollaboratorCandidate,
  ContentModerationInput,
  ContentModerationResult,
  ProjectCandidate,
  ProjectSummaryInput,
  ProjectSummaryResult,
  RecommendationInput,
  RecommendationResult,
  TagSuggestionInput,
  TagSuggestionResult,
} from "./ai.types.js";

/**
 * `AIService` — the class ARCHITECTURE §22 names, carrying the five methods
 * it names, and the only AI surface the rest of the application may touch.
 *
 * *"The application should call AIService rather than directly calling a
 * specific provider. This allows provider replacement."* Everything below
 * exists to make that sentence true in practice rather than by convention:
 * the provider is private, it is injected, and no method leaks its type.
 *
 * Three guarantees hold for every method:
 *
 *  1. **It never throws.** A provider fault becomes
 *     `{ available: false, reason: "provider_error" }`. AI enriches; it is
 *     never load-bearing, and a summariser outage must not fail the write
 *     that asked for a summary. `EmailService` swallows transport failures
 *     for exactly this reason, and `NotificationPort` is fire-and-forget on
 *     the same principle.
 *  2. **Unsupported capabilities never reach the provider.** The capability
 *     check runs first, so a partially-implemented provider answers
 *     `capability_unsupported` instead of throwing from a stub.
 *  3. **No user content is ever logged.** Failures record the provider, the
 *     capability, and the error — never the text that was summarised,
 *     moderated, or tagged. This is the same rule
 *     `ConsoleEmailProvider` follows for reset tokens (TRD §30), and it
 *     matters more here: the text passed to `moderateContent` is by
 *     definition the most sensitive on the platform.
 */
export class AIService {
  constructor(private readonly provider: AIProvider) {}

  /** Identifies the active provider in logs and health output. */
  get providerName(): string {
    return this.provider.name;
  }

  /** Whether the active provider implements a capability. */
  supports(capability: AICapability): boolean {
    return this.provider.capabilities.includes(capability);
  }

  /**
   * The single guarded path every public method funnels through.
   *
   * `validate` runs before the capability check is spent and before any
   * provider work, so a malformed request costs nothing.
   */
  private async run<T>(
    capability: AICapability,
    valid: boolean,
    call: () => Promise<T>,
  ): Promise<AIResult<T>> {
    if (!this.supports(capability)) {
      return {
        available: false,
        reason:
          this.provider.capabilities.length === 0
            ? "provider_disabled"
            : "capability_unsupported",
      };
    }

    if (!valid) return { available: false, reason: "invalid_input" };

    try {
      return { available: true, data: await call() };
    } catch (error) {
      logger.error(
        { err: error, provider: this.provider.name, capability },
        "AI provider call failed — the calling operation is unaffected",
      );
      return { available: false, reason: "provider_error" };
    }
  }

  /**
   * A one-paragraph description of a project (ARCHITECTURE §22).
   *
   * Requires something to summarise: a request carrying neither a title nor a
   * description is the caller's bug, not an empty result.
   */
  async generateProjectSummary(
    input: ProjectSummaryInput,
  ): Promise<AIResult<ProjectSummaryResult>> {
    const hasSource =
      input.title.trim().length > 0 || input.description.trim().length > 0;

    return this.run("project_summary", hasSource, () =>
      this.provider.generateProjectSummary(input),
    );
  }

  /**
   * Advisory classification of user-authored text (ARCHITECTURE §22).
   *
   * **This does not moderate anything.** It returns an opinion. Phase 11 owns
   * enforcement, and every action there requires a ranked human actor and
   * writes an audit row in the same transaction. A caller may use this to
   * order a review queue or warn an author before they post; using it to
   * remove content or sanction an account without human review would put
   * automated punishment behind a provider's confidence score.
   */
  async moderateContent(
    input: ContentModerationInput,
  ): Promise<AIResult<ContentModerationResult>> {
    return this.run("content_moderation", input.text.trim().length > 0, () =>
      this.provider.moderateContent(input),
    );
  }

  /** Tags for a project, drawn from the caller's vocabulary (ARCHITECTURE §22). */
  async suggestTags(input: TagSuggestionInput): Promise<AIResult<TagSuggestionResult>> {
    const hasSource =
      input.title.trim().length > 0 || input.description.trim().length > 0;

    return this.run("tag_suggestion", hasSource, () => this.provider.suggestTags(input));
  }

  /**
   * Ranks supplied project candidates for a viewer (ARCHITECTURE §22).
   *
   * The caller supplies the candidates. This layer performs no I/O, so it
   * cannot widen what a viewer may see: whatever visibility rules produced
   * the candidate list still bound the result, and a ranker that queried for
   * its own candidates would be a second, unaudited read path around them.
   */
  async recommendProjects(
    input: RecommendationInput<ProjectCandidate>,
  ): Promise<AIResult<RecommendationResult>> {
    return this.run("project_recommendation", input.viewer.id.length > 0, () =>
      this.provider.recommendProjects(input),
    );
  }

  /** Ranks supplied collaborator candidates for a viewer (ARCHITECTURE §22). */
  async recommendCollaborators(
    input: RecommendationInput<CollaboratorCandidate>,
  ): Promise<AIResult<RecommendationResult>> {
    return this.run("collaborator_recommendation", input.viewer.id.length > 0, () =>
      this.provider.recommendCollaborators(input),
    );
  }
}
