import { env } from "../../config/env.js";
import { AIService } from "./ai.service.js";
import type { AIProvider } from "./ai.types.js";
import { DisabledAIProvider } from "./disabled.provider.js";
import { LocalAIProvider } from "./local.provider.js";

/**
 * Composition root for AI (BACKEND_TRD.md §27, BACKEND_ARCHITECTURE.md §22).
 *
 * This `switch` is the only place in the codebase that knows which provider
 * is active — the property PRD §20 asks for when it requires that *"AI
 * providers must be replaceable without redesigning the application."*
 * Adding OpenAI, Anthropic, Google, or a self-hosted model means one new file
 * implementing `AIProvider`, one new `case` here, and one new value in
 * `AI_PROVIDER`'s enum. No service, controller, route, or test outside this
 * directory changes.
 *
 * Modelled on `integrations/email/index.ts`, deliberately: a second
 * abstraction shape for the same problem would be the "second architectural
 * pattern" the phase rules forbid.
 */
function createProvider(): AIProvider {
  switch (env.AI_PROVIDER) {
    case "local":
      return new LocalAIProvider();
    case "disabled":
      return new DisabledAIProvider();
  }
}

export const aiService = new AIService(createProvider());

export { AIService } from "./ai.service.js";
export { DisabledAIProvider } from "./disabled.provider.js";
export { LocalAIProvider } from "./local.provider.js";
export {
  AI_CAPABILITIES,
  MODERATION_CATEGORIES,
  type AICapability,
  type AIProvider,
  type AIResult,
  type AIUnavailableReason,
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
  type RecommendationViewer,
  type TagSuggestionInput,
  type TagSuggestionResult,
} from "./ai.types.js";
