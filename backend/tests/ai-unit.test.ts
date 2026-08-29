import { describe, expect, it, vi } from "vitest";

import { parseEnv } from "../src/config/env.js";
import { AIService } from "../src/integrations/ai/ai.service.js";
import {
  AI_CAPABILITIES,
  MODERATION_CATEGORIES,
  type AICapability,
  type AIProvider,
  type CollaboratorCandidate,
  type ProjectCandidate,
  type Recommendation,
} from "../src/integrations/ai/ai.types.js";
import { DisabledAIProvider } from "../src/integrations/ai/disabled.provider.js";
import { LocalAIProvider } from "../src/integrations/ai/local.provider.js";
import { aiService } from "../src/integrations/ai/index.js";
import { logger } from "../src/utils/logger.js";

/**
 * The AI abstraction (PRD §20, TRD §27, ARCHITECTURE §22).
 *
 * Phase 12 ships a seam, not an endpoint — ARCHITECTURE §29 names no
 * `/api/v1/ai` root — so the contract is enforced here rather than over HTTP.
 * Two things are being pinned:
 *
 *   1. **The abstraction holds.** Callers get a typed result and never an
 *      exception, unsupported capabilities never reach the provider, and no
 *      user content reaches the logs.
 *   2. **The local provider is exactly reproducible.** Every expected value
 *      below is computable by hand from its input, which is the property that
 *      makes a heuristic honest: if a number here changes, the heuristic
 *      changed.
 */

const LOCAL = new LocalAIProvider();
const service = new AIService(LOCAL);

const VIEWER = { id: "viewer-1", interests: ["rust", "cli"] };
const NOW = new Date("2026-06-01T00:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}

/** A provider that fails every call, for the never-throws guarantee. */
class ExplodingProvider implements AIProvider {
  readonly name = "exploding";
  readonly capabilities: readonly AICapability[] = AI_CAPABILITIES;

  generateProjectSummary(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
  moderateContent(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
  suggestTags(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
  recommendProjects(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
  recommendCollaborators(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
}

/**
 * Implements the interface but advertises only one capability.
 *
 * Delegates rather than extends: `LocalAIProvider.name` is the literal type
 * `"local"`, so a subclass cannot rename itself — which is the type system
 * correctly refusing to let one provider impersonate another.
 */
class PartialProvider implements AIProvider {
  readonly name = "partial";
  readonly capabilities: readonly AICapability[] = ["project_summary"];

  generateProjectSummary = LOCAL.generateProjectSummary.bind(LOCAL);
  moderateContent = LOCAL.moderateContent.bind(LOCAL);
  suggestTags = LOCAL.suggestTags.bind(LOCAL);
  recommendProjects = LOCAL.recommendProjects.bind(LOCAL);
  recommendCollaborators = LOCAL.recommendCollaborators.bind(LOCAL);
}

/**
 * A wholly different implementation — abstractive rather than extractive,
 * with its own scoring — standing in for the hosted provider a later phase
 * will add. It shares no code with `LocalAIProvider`.
 */
class StubProvider implements AIProvider {
  readonly name = "stub";
  readonly capabilities: readonly AICapability[] = AI_CAPABILITIES;

  generateProjectSummary(): Promise<{
    summary: string;
    method: "extractive" | "abstractive";
  }> {
    return Promise.resolve({ summary: "a generated summary", method: "abstractive" });
  }
  moderateContent(): Promise<{
    verdict: "allow";
    score: number;
    categories: readonly never[];
  }> {
    return Promise.resolve({ verdict: "allow", score: 0, categories: [] });
  }
  suggestTags(): Promise<{ tags: readonly string[] }> {
    return Promise.resolve({ tags: ["stubbed"] });
  }
  recommendProjects(): Promise<{ recommendations: readonly Recommendation[] }> {
    return Promise.resolve({
      recommendations: [{ id: "stub-1", score: 1, reasons: ["stub"] }],
    });
  }
  recommendCollaborators(): Promise<{ recommendations: readonly Recommendation[] }> {
    return Promise.resolve({
      recommendations: [{ id: "stub-2", score: 1, reasons: ["stub"] }],
    });
  }
}

describe("Provider replacement — the property PRD §20 requires", () => {
  /**
   * *"AI providers must be replaceable without redesigning the application."*
   *
   * The proof is that this block swaps the provider and calls the service
   * through the same consumer code, with `AIService` unmodified and no
   * dependency added. Everything a real caller touches is below.
   */
  async function consumer(ai: AIService) {
    const summary = await ai.generateProjectSummary({
      title: "ForgeHub",
      description: "A social platform for builders.",
    });
    const tags = await ai.suggestTags({ title: "Rust CLI", description: "A tool." });

    return { summary, tags, provider: ai.providerName };
  }

  it("runs identical consumer code against two unrelated providers", async () => {
    const local = await consumer(new AIService(LOCAL));
    const stub = await consumer(new AIService(new StubProvider()));

    // Same call sites, same result shape, different provider and data.
    expect(local.provider).toBe("local");
    expect(stub.provider).toBe("stub");

    expect(local.summary.available).toBe(true);
    expect(stub.summary.available).toBe(true);
    if (!local.summary.available || !stub.summary.available) return;

    expect(local.summary.data.method).toBe("extractive");
    expect(stub.summary.data.method).toBe("abstractive");
    expect(stub.summary.data.summary).toBe("a generated summary");

    expect(stub.tags.available).toBe(true);
    if (!stub.tags.available) return;
    expect(stub.tags.data.tags).toEqual(["stubbed"]);
  });

  it("requires nothing of a provider beyond the AIProvider interface", () => {
    // A structural check: the stub satisfies AIProvider by shape alone. It
    // extends nothing, imports no SDK, and shares no code with the local
    // provider — which is what "replaceable" has to mean to be worth anything.
    const stub: AIProvider = new StubProvider();

    expect(stub.capabilities).toEqual(AI_CAPABILITIES);
    expect(stub).not.toBeInstanceOf(LocalAIProvider);
  });
});

describe("AIService — the abstraction ARCHITECTURE §22 requires", () => {
  it("exposes exactly the five methods §22 names", () => {
    // The specification lists them by name; drift here is drift from the spec.
    for (const method of [
      "generateProjectSummary",
      "moderateContent",
      "suggestTags",
      "recommendProjects",
      "recommendCollaborators",
    ] as const) {
      expect(typeof service[method]).toBe("function");
    }
  });

  it("exposes a provider name, not the provider, on its public surface", () => {
    expect(service.providerName).toBe("local");

    // `private` is a compile-time guarantee, so the field does exist at
    // runtime; what is asserted here is the shape callers are offered. The
    // prototype carries the five §22 methods plus the two accessors, and
    // nothing that hands back the provider object.
    const surface = Object.getOwnPropertyNames(AIService.prototype)
      .filter((name) => name !== "constructor" && !name.startsWith("run"))
      .sort();

    expect(surface).toEqual([
      "generateProjectSummary",
      "moderateContent",
      "providerName",
      "recommendCollaborators",
      "recommendProjects",
      "suggestTags",
      "supports",
    ]);
  });

  it("reports capabilities from the provider", () => {
    expect(AI_CAPABILITIES).toHaveLength(5);
    for (const capability of AI_CAPABILITIES) {
      expect(service.supports(capability)).toBe(true);
    }
  });

  it("never throws when the provider does, and reports provider_error", async () => {
    const failing = new AIService(new ExplodingProvider());

    const results = await Promise.all([
      failing.generateProjectSummary({ title: "t", description: "d" }),
      failing.moderateContent({ text: "hello" }),
      failing.suggestTags({ title: "t", description: "d" }),
      failing.recommendProjects({ viewer: VIEWER, candidates: [] }),
      failing.recommendCollaborators({ viewer: VIEWER, candidates: [] }),
    ]);

    for (const result of results) {
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toBe("provider_error");
    }
  });

  it("logs a provider failure without the user content that caused it", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => logger);
    const secret = "a private message that must never reach the log stream";

    try {
      await new AIService(new ExplodingProvider()).moderateContent({ text: secret });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(spy.mock.calls[0])).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers capability_unsupported without calling a partial provider", async () => {
    const partial = new AIService(new PartialProvider());

    expect(partial.supports("project_summary")).toBe(true);
    expect(partial.supports("content_moderation")).toBe(false);

    const summary = await partial.generateProjectSummary({ title: "t", description: "" });
    expect(summary.available).toBe(true);

    const moderation = await partial.moderateContent({ text: "hello" });
    expect(moderation.available).toBe(false);
    if (!moderation.available) expect(moderation.reason).toBe("capability_unsupported");
  });

  it("rejects input with nothing to work on", async () => {
    const blank = await service.generateProjectSummary({ title: "  ", description: "" });
    expect(blank.available).toBe(false);
    if (!blank.available) expect(blank.reason).toBe("invalid_input");

    const empty = await service.moderateContent({ text: "   " });
    expect(empty.available).toBe(false);
    if (!empty.available) expect(empty.reason).toBe("invalid_input");
  });

  it("reports a disabled provider before it validates input", async () => {
    // Ordering matters: "AI is off" is the useful answer, and it must not be
    // masked by a complaint about the payload.
    const off = new AIService(new DisabledAIProvider());
    const result = await off.generateProjectSummary({ title: "", description: "" });

    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("provider_disabled");
  });
});

describe("DisabledAIProvider — the off switch", () => {
  const off = new AIService(new DisabledAIProvider());

  it("declares no capabilities", () => {
    expect(new DisabledAIProvider().capabilities).toEqual([]);
    for (const capability of AI_CAPABILITIES) {
      expect(off.supports(capability)).toBe(false);
    }
  });

  it("reports provider_disabled for every capability, and never throws", async () => {
    const results = await Promise.all([
      off.generateProjectSummary({ title: "t", description: "d" }),
      off.moderateContent({ text: "hello" }),
      off.suggestTags({ title: "t", description: "d" }),
      off.recommendProjects({ viewer: VIEWER, candidates: [] }),
      off.recommendCollaborators({ viewer: VIEWER, candidates: [] }),
    ]);

    for (const result of results) {
      expect(result.available).toBe(false);
      if (!result.available) expect(result.reason).toBe("provider_disabled");
    }
  });
});

describe("LocalAIProvider — project summaries", () => {
  it("returns a short description unchanged and marks it extractive", async () => {
    const result = await service.generateProjectSummary({
      title: "ForgeHub",
      description: "A social platform for builders.",
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.summary).toBe("A social platform for builders.");
    // Extractive is a guarantee, not a label: nothing was generated, so
    // nothing can have been hallucinated.
    expect(result.data.method).toBe("extractive");
  });

  it("falls back to the title when there is no description", async () => {
    const result = await service.generateProjectSummary({
      title: "ForgeHub",
      description: "   ",
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.summary).toBe("ForgeHub");
  });

  it("stops on a sentence boundary rather than mid-thought", async () => {
    const result = await service.generateProjectSummary({
      title: "x",
      description: "One. Two. Three.",
      maxLength: 10,
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.summary).toBe("One. Two.");
  });

  it("cuts at a word boundary and marks the cut when one sentence overruns", async () => {
    const result = await service.generateProjectSummary({
      title: "x",
      description: "aaaa bbbb cccc dddd",
      maxLength: 10,
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.data.summary).toBe("aaaa bbbb…");

    // The real guarantee: what precedes the ellipsis is a prefix of the source
    // that ends on a word boundary — never half a word.
    const source = "aaaa bbbb cccc dddd";
    const kept = result.data.summary.slice(0, -1);
    expect(source.startsWith(kept)).toBe(true);
    expect(source.charAt(kept.length)).toBe(" ");
  });

  it("honours the length budget across a range of inputs", async () => {
    const description = "Lorem ipsum dolor sit amet. ".repeat(40);

    for (const maxLength of [20, 60, 140, 280]) {
      const result = await service.generateProjectSummary({
        title: "x",
        description,
        maxLength,
      });

      expect(result.available).toBe(true);
      if (!result.available) continue;
      expect(result.data.summary.length).toBeLessThanOrEqual(maxLength + 1); // +1 = "…"
    }
  });
});

describe("LocalAIProvider — content moderation", () => {
  async function verdictOf(text: string) {
    const result = await service.moderateContent({ text });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    return result.data;
  }

  it("allows clean text with no categories and a zero score", async () => {
    const data = await verdictOf("I shipped a new Rust CLI this week.");
    expect(data).toEqual({ verdict: "allow", score: 0, categories: [] });
  });

  it("flags a single indicator for review, never rejection", async () => {
    const data = await verdictOf("buy now while stocks last");
    expect(data.verdict).toBe("review");
    expect(data.categories).toEqual(["spam"]);
    expect(data.score).toBe(0.25); // 1 of 4 categories, one hit
  });

  it("is case-insensitive", async () => {
    const lower = await verdictOf("buy now");
    const upper = await verdictOf("BUY NOW");
    expect(upper).toEqual(lower);
  });

  it("scores multiple categories above a single one", async () => {
    const one = await verdictOf("buy now");
    const two = await verdictOf("buy now, you idiot");

    expect(two.score).toBeGreaterThan(one.score);
    expect(two.categories).toEqual(["spam", "harassment"]);
  });

  it("rejects only when the signal is strong", async () => {
    const data = await verdictOf("buy now — click here, you idiot, I will kill you");

    expect(data.verdict).toBe("reject");
    expect(data.score).toBeGreaterThanOrEqual(0.67);
    expect(data.categories).toEqual(["spam", "harassment", "violence"]);
  });

  it("keeps every score inside [0, 1] even when everything matches", async () => {
    const data = await verdictOf(
      "buy now click here free money work from home crypto giveaway " +
        "idiot loser shut up nobody likes you kill you hunt you down " +
        "beat you up kill myself end my life want to die",
    );

    expect(data.score).toBeLessThanOrEqual(1);
    expect(data.score).toBeGreaterThan(0);
    expect(data.categories).toEqual([...MODERATION_CATEGORIES]);
  });

  it("returns an opinion and nothing that could act on its own", async () => {
    // The result type carries no user id, no action, and no verb — it cannot
    // be mistaken for a moderation decision. Phase 11 owns enforcement and
    // requires a ranked human actor for every action.
    const data = await verdictOf("buy now");
    expect(Object.keys(data).sort()).toEqual(["categories", "score", "verdict"]);
    expect(["allow", "review", "reject"]).toContain(data.verdict);
  });
});

describe("LocalAIProvider — tag suggestions", () => {
  async function tagsOf(input: Parameters<typeof service.suggestTags>[0]) {
    const result = await service.suggestTags(input);
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    return result.data.tags;
  }

  it("returns only tags the caller's vocabulary contains", async () => {
    const tags = await tagsOf({
      title: "Machine Learning Toolkit",
      description: "A toolkit for machine learning.",
      vocabulary: ["Machine Learning", "Rust", "toolkit"],
    });

    // "Rust" appears in the vocabulary but not the text, so it is not invented.
    expect(tags).toEqual(["toolkit", "Machine Learning"]);
  });

  it("matches multi-word vocabulary entries against the text", async () => {
    const tags = await tagsOf({
      title: "Notes",
      description: "Experiments in machine learning.",
      vocabulary: ["machine learning"],
    });

    expect(tags).toEqual(["machine learning"]);
  });

  it("preserves the vocabulary's own casing", async () => {
    const tags = await tagsOf({
      title: "rust things",
      description: "rust",
      vocabulary: ["Rust"],
    });

    expect(tags).toEqual(["Rust"]);
  });

  it("derives keywords when no vocabulary is supplied, skipping stopwords", async () => {
    const tags = await tagsOf({
      title: "Rust CLI",
      description: "A fast rust cli tool for rust developers.",
    });

    expect(tags[0]).toBe("rust"); // most frequent
    expect(tags[1]).toBe("cli");
    for (const stopword of ["a", "for", "the"]) {
      expect(tags).not.toContain(stopword);
    }
  });

  it("respects the limit", async () => {
    const tags = await tagsOf({
      title: "alpha beta gamma delta epsilon zeta",
      description: "alpha beta gamma delta epsilon zeta",
      limit: 3,
    });

    expect(tags).toHaveLength(3);
  });

  it("returns nothing rather than guessing when the vocabulary matches nothing", async () => {
    const tags = await tagsOf({
      title: "Rust CLI",
      description: "A command line tool.",
      vocabulary: ["Kubernetes", "Terraform"],
    });

    expect(tags).toEqual([]);
  });
});

describe("LocalAIProvider — project recommendations", () => {
  const base: ProjectCandidate = {
    id: "p1",
    ownerId: "owner-1",
    tags: ["rust"],
    engagementCount: 10,
    createdAt: NOW,
  };

  async function recommend(candidates: ProjectCandidate[], limit?: number) {
    const result = await service.recommendProjects({
      viewer: VIEWER,
      candidates,
      ...(limit === undefined ? {} : { limit }),
      now: NOW,
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    return result.data.recommendations;
  }

  it("never recommends the viewer their own project", async () => {
    const own: ProjectCandidate = { ...base, id: "mine", ownerId: VIEWER.id };
    const ids = (await recommend([base, own])).map((entry) => entry.id);

    expect(ids).toContain("p1");
    expect(ids).not.toContain("mine");
  });

  it("scores a tag match above an unrelated project", async () => {
    const unrelated: ProjectCandidate = { ...base, id: "p2", tags: ["cobol"] };
    const [first, second] = await recommend([unrelated, base]);

    expect(first?.id).toBe("p1");
    expect(first?.reasons).toContain("shared_tags");
    expect(second?.reasons ?? []).not.toContain("shared_tags");
  });

  it("decays with age", async () => {
    const old: ProjectCandidate = { ...base, id: "p2", createdAt: daysAgo(120) };
    const [fresh, stale] = await recommend([old, base]);

    expect(fresh?.id).toBe("p1");
    expect(fresh?.reasons).toContain("recent");
    expect(stale?.reasons ?? []).not.toContain("recent");
  });

  it("boosts a project whose owner the viewer follows", async () => {
    const withoutFollow = await recommend([base]);

    const result = await service.recommendProjects({
      viewer: { ...VIEWER, followingIds: ["owner-1"] },
      candidates: [base],
      now: NOW,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;

    const boosted = result.data.recommendations[0];
    expect(boosted?.score).toBeGreaterThan(withoutFollow[0]?.score ?? 0);
    expect(boosted?.reasons).toContain("follows_owner");
  });

  it("keeps every score inside [0, 1]", async () => {
    const maxed: ProjectCandidate = {
      id: "p9",
      ownerId: "owner-9",
      tags: ["rust", "cli"],
      engagementCount: 1_000_000,
      createdAt: NOW,
    };

    const result = await service.recommendProjects({
      viewer: { ...VIEWER, followingIds: ["owner-9"] },
      candidates: [maxed],
      now: NOW,
    });
    expect(result.available).toBe(true);
    if (!result.available) return;

    const score = result.data.recommendations[0]?.score ?? -1;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("breaks ties by id so paging is stable", async () => {
    const b: ProjectCandidate = { ...base, id: "bbb", ownerId: "o" };
    const a: ProjectCandidate = { ...base, id: "aaa", ownerId: "o" };

    expect((await recommend([b, a])).map((entry) => entry.id)).toEqual(["aaa", "bbb"]);
  });

  it("respects the limit and tolerates an empty candidate set", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...base,
      id: `p${index}`,
      ownerId: `o${index}`,
    }));

    expect(await recommend(many, 3)).toHaveLength(3);
    expect(await recommend([])).toEqual([]);
  });
});

describe("LocalAIProvider — collaborator recommendations", () => {
  const candidates: CollaboratorCandidate[] = [
    { id: "u1", skills: ["rust", "cli"], projectsCount: 4 },
    { id: "u2", skills: ["design"], projectsCount: 9 },
    { id: VIEWER.id, skills: ["rust", "cli"], projectsCount: 20 },
    { id: "u4", skills: ["rust"], projectsCount: 1 },
  ];

  async function recommend(followingIds?: string[]) {
    const result = await service.recommendCollaborators({
      viewer: { ...VIEWER, ...(followingIds === undefined ? {} : { followingIds }) },
      candidates,
    });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error("unreachable");
    return result.data.recommendations;
  }

  it("never recommends the viewer to themselves", async () => {
    expect((await recommend()).map((entry) => entry.id)).not.toContain(VIEWER.id);
  });

  it("excludes people the viewer already follows", async () => {
    // The feature is discovery; someone already followed is not a discovery.
    expect((await recommend(["u1"])).map((entry) => entry.id)).not.toContain("u1");
  });

  it("ranks a full skill match above a partial one, and both above none", async () => {
    const ids = (await recommend()).map((entry) => entry.id);

    expect(ids[0]).toBe("u1"); // both skills
    expect(ids.indexOf("u4")).toBeLessThan(ids.indexOf("u2")); // partial beats none
  });

  it("explains itself", async () => {
    const [top] = await recommend();
    expect(top?.reasons).toContain("shared_skills");
    expect(top?.reasons).toContain("active_builder");
  });
});

describe("AI_PROVIDER — the configuration seam", () => {
  // Asserted here rather than in `config.test.ts` so a Phase 12 variable is
  // covered by Phase 12's own suite and no earlier phase's test file moves.
  const REQUIRED = {
    DATABASE_URL: "postgres://u:p@localhost:5432/db",
    REDIS_URL: "redis://localhost:6379",
    JWT_ACCESS_SECRET: "d3JhcHBlZC1hY2Nlc3Mtc2VjcmV0LWZvci10ZXN0aW5nLW9ubHk",
    JWT_REFRESH_SECRET: "d3JhcHBlZC1yZWZyZXNoLXNlY3JldC1mb3ItdGVzdGluZy1vbmx5",
    TWO_FACTOR_SECRET_KEY: "d3JhcHBlZC10d28tZmFjdG9yLWtleS1mb3ItdGVzdGluZy1vbmx5",
  };

  it("defaults to the local provider so a fresh checkout has a working seam", () => {
    expect(parseEnv({ ...REQUIRED }).AI_PROVIDER).toBe("local");
  });

  it("accepts every provider the composition root can build", () => {
    for (const provider of ["local", "disabled"] as const) {
      expect(parseEnv({ ...REQUIRED, AI_PROVIDER: provider }).AI_PROVIDER).toBe(provider);
    }
  });

  it("refuses a provider that has no implementation", () => {
    // Fail at boot, not at the first call that happens to need a summary.
    expect(() => parseEnv({ ...REQUIRED, AI_PROVIDER: "openai" })).toThrow();
  });
});

describe("The composition root", () => {
  it("composes the local provider by default", () => {
    // `AI_PROVIDER` defaults to "local", so a checkout with no AI config still
    // has a working, dependency-free seam.
    expect(aiService.providerName).toBe("local");
    expect(aiService).toBeInstanceOf(AIService);
  });

  it("performs no I/O — the seam is pure", async () => {
    // Nothing in this directory imports Prisma, Redis, or fetch. If that ever
    // changes, this file's other tests would need a database to run.
    const result = await aiService.suggestTags({
      title: "Rust CLI",
      description: "A fast tool.",
    });

    expect(result.available).toBe(true);
  });
});
