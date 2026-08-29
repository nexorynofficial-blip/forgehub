import type {
  AICapability,
  AIProvider,
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
 * The off switch: a provider that implements nothing.
 *
 * AI is the one subsystem in this backend that a deployment may legitimately
 * not want at all — it is optional in PRD §20 ("Potential features"), it is
 * the only subsystem whose realistic providers bill per call, and it is the
 * only one that would ship user-authored text to a third party. An operator
 * must be able to turn it off in configuration, and get a definite answer
 * rather than silence.
 *
 * It declares **no capabilities**, so `AIService` short-circuits every call
 * to `{ available: false, reason: "provider_disabled" }` without this class's
 * methods ever running. They exist to satisfy the interface, and each one
 * rejects rather than returning a plausible empty value: a caller that
 * somehow reached a disabled provider directly should fail loudly instead of
 * quietly receiving an empty summary that looks like a real result.
 *
 * Contrast `ConsoleEmailProvider`, which *does* deliver in development.
 * Email has no meaningful "off" — a registration that sends no verification
 * mail is broken — whereas AI that is off is simply a platform without AI.
 */
export class DisabledAIProvider implements AIProvider {
  readonly name = "disabled";
  readonly capabilities: readonly AICapability[] = [];

  private unavailable(capability: string): Promise<never> {
    return Promise.reject(
      new Error(`AI provider is disabled — ${capability} is unavailable`),
    );
  }

  generateProjectSummary(_input: ProjectSummaryInput): Promise<ProjectSummaryResult> {
    return this.unavailable("generateProjectSummary");
  }

  moderateContent(_input: ContentModerationInput): Promise<ContentModerationResult> {
    return this.unavailable("moderateContent");
  }

  suggestTags(_input: TagSuggestionInput): Promise<TagSuggestionResult> {
    return this.unavailable("suggestTags");
  }

  recommendProjects(
    _input: RecommendationInput<ProjectCandidate>,
  ): Promise<RecommendationResult> {
    return this.unavailable("recommendProjects");
  }

  recommendCollaborators(
    _input: RecommendationInput<CollaboratorCandidate>,
  ): Promise<RecommendationResult> {
    return this.unavailable("recommendCollaborators");
  }
}
