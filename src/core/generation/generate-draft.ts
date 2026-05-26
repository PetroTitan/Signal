import "server-only";
/**
 * Phase F4.5 — generate-draft entry point.
 *
 * Sequence:
 *   1. Load the publishing identity context (voice, product, recent
 *      publishes, platform guidance).
 *   2. Build the GenerationPrompt (pure).
 *   3. If an AI provider is configured: dispatch to it. Re-evaluate
 *      the response with the safety rules. Refuse to return banned
 *      content; fall back to manual-seed.
 *   4. If no provider is configured: return a manual-seed result
 *      with the topic/goal/source preserved in metadata. The
 *      founder fills in the body via the compose sheet; an external
 *      Claude/Codex agent can also fulfill the draft via MCP using
 *      the same context.
 *
 * The provider HTTP calls are stubbed for now — Signal has no
 * provider key in this environment. The shape is wired so adding a
 * real provider is a localized change.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import type { PublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import {
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";
import { buildGenerationPrompt } from "./prompt-builder";
import { evaluateDraftSafety } from "./safety-rules";
import { readGenerationProviderStatus } from "./provider-status";
import {
  activeProvider,
  callGenerationProvider,
} from "./providers";
import { assemblePlatformNativeDraft } from "./assemble-platform-native-result";
import type { PlatformNativeDraft } from "@/core/platform-native";
import type {
  GenerationDraft,
  GenerationInput,
  GenerationPromptContext,
  GenerationResult,
} from "./generation-types";

/**
 * Founder platforms the platform-native engine knows about. Outside
 * this set we still produce a minimal envelope (see
 * makeFallbackPlatformNativeDraft) so the return type is always
 * complete.
 */
const NATIVE_ENGINE_PLATFORMS: ReadonlySet<string> = new Set<FounderPlatform>([
  "reddit",
  "x",
  "bluesky",
  "linkedin",
  "threads",
  "instagram",
  "telegram",
  "devto",
  "hashnode",
  "youtube",
  "indie_hackers",
]);

const SIMILARITY_MIN_TOPIC_LEN = 12;

export async function generateDraft(input: {
  workspaceId: string;
  generation: GenerationInput;
  /**
   * Optional Supabase client to use when loading the identity
   * context. UI callers (server actions running inside a cookie
   * session) leave this unset and get the cookie-aware client. The
   * MCP planning tools pass `ctx.db` so the identity-context lookup
   * works without a Supabase cookie session (operator tokens use
   * bearer auth on /api/mcp; there is no cookie on those requests).
   */
  db?: SupabaseClient;
}): Promise<GenerationResult> {
  const identityContext = await getPublishingIdentityContext({
    workspaceId: input.workspaceId,
    identityId: input.generation.identityId,
    historyLimit: 5,
    db: input.db,
  });
  if (!identityContext) {
    const fallbackDraft = emptyDraft(input.generation);
    return {
      providerUsed: false,
      status: "provider_unavailable",
      draft: fallbackDraft,
      // No identity → no platform context. We still return a
      // minimal envelope so callers can rely on a complete shape.
      platformNativeDraft: makeFallbackPlatformNativeDraft({
        platform: input.generation.platform ?? "x",
        draft: fallbackDraft,
      }),
      similarityWarning:
        "Couldn't find this publishing identity. Refresh and try again.",
    };
  }

  const platform =
    input.generation.platform?.trim() || identityContext.platform;
  const guidance = resolveIdentityPlatformGuidance(platform);
  const promptContext: GenerationPromptContext = {
    identityDisplayName: identityContext.displayName,
    identityHandle: identityContext.handle,
    platform,
    platformLabel: guidance?.label ?? identityContext.platformLabel,
    voiceProfile: identityContext.voiceProfile,
    sourceWebsiteUrl: identityContext.sourceWebsiteUrl,
    referenceUrls: identityContext.referenceUrls,
    product: identityContext.associatedProduct
      ? {
          name: identityContext.associatedProduct.name,
          domain: identityContext.associatedProduct.domain,
          summary: identityContext.associatedProduct.summary,
          category: identityContext.associatedProduct.category,
        }
      : null,
    platformVoiceHint: guidance?.voiceHint ?? null,
    // Title hashes don't reconstruct the original topic — we'd need
    // the plan-item title to do similarity. For now, surface the
    // platform's recent permalinks as fuzzy "recently published"
    // hints; the prompt tells the model to avoid repeating.
    recentTopics: identityContext.publishingHistory
      .map((h) => h.permalink ?? "")
      .filter((s) => s.length > 0),
    input: input.generation,
  };

  const similarityWarning = detectSimilarTopic(
    input.generation.topic,
    promptContext.recentTopics,
  );

  const provider = readGenerationProviderStatus();
  if (!provider.available) {
    const seeded = seededDraftFromInputs(input.generation, promptContext);
    return {
      providerUsed: false,
      status: "provider_unavailable",
      draft: seeded,
      platformNativeDraft: buildEnvelope({
        identityContext,
        platform,
        generation: input.generation,
        draft: seeded,
      }),
      similarityWarning,
    };
  }

  const prompt = buildGenerationPrompt(promptContext);

  // ── Real provider dispatch (F4.6).
  const response = await callGenerationProvider({
    system: prompt.system,
    user: prompt.user,
  });

  if (!response.ok) {
    const seeded = seededDraftFromInputs(input.generation, promptContext);
    return {
      providerUsed: false,
      status: "provider_unavailable",
      draft: seeded,
      platformNativeDraft: buildEnvelope({
        identityContext,
        platform,
        generation: input.generation,
        draft: seeded,
      }),
      similarityWarning,
    };
  }

  const verdict = evaluateDraftSafety({
    title: null,
    body: response.text,
  });
  if (!verdict.ok) {
    const refused: GenerationDraft = {
      ...seededDraftFromInputs(input.generation, promptContext),
      safetyNotes: verdict.violations,
    };
    return {
      providerUsed: true,
      status: "provider_refused",
      draft: refused,
      platformNativeDraft: buildEnvelope({
        identityContext,
        platform,
        generation: input.generation,
        draft: refused,
      }),
      similarityWarning,
    };
  }

  const generated = parseDraft(response.text, input.generation, promptContext);
  return {
    providerUsed: true,
    status: "provider_generated",
    draft: generated,
    platformNativeDraft: buildEnvelope({
      identityContext,
      platform,
      generation: input.generation,
      draft: generated,
    }),
    similarityWarning,
  };
}

/**
 * Centralized envelope builder. Routes every founder-platform draft
 * through the platform-native engine so the LLM call site stays the
 * only place producing body text — the engine layers the typed
 * envelope (creativeDirection, format, warnings, riskLevel,
 * transformationNotes) on top.
 *
 * For platforms outside the founder set (experimental callers via
 * MCP, for example), produces a fallback envelope so the return
 * type is always complete and never null.
 */
function buildEnvelope(input: {
  identityContext: PublishingIdentityContext;
  platform: string;
  generation: GenerationInput;
  draft: GenerationDraft;
}): PlatformNativeDraft {
  if (NATIVE_ENGINE_PLATFORMS.has(input.platform)) {
    return assemblePlatformNativeDraft({
      identityContext: input.identityContext,
      platform: input.platform as FounderPlatform,
      generation: input.generation,
      draft: input.draft,
    });
  }
  return makeFallbackPlatformNativeDraft({
    platform: input.platform,
    draft: input.draft,
  });
}

/**
 * Minimal PlatformNativeDraft for platforms we don't have a profile
 * for. Carries the body verbatim and surfaces a single warning so
 * the operator knows the rich shaping wasn't applied. This is the
 * safety net — never returned for any of the 11 founder platforms.
 */
function makeFallbackPlatformNativeDraft(input: {
  platform: string;
  draft: GenerationDraft;
}): PlatformNativeDraft {
  return {
    // Cast: callers receiving this fallback should treat platform
    // string as opaque; the type widening is intentional and gated
    // by NATIVE_ENGINE_PLATFORMS upstream.
    platform: input.platform as FounderPlatform,
    title: input.draft.title,
    hook: "",
    body: input.draft.bodyMarkdown,
    cta: input.draft.ctaSuggestion,
    format: "single_post",
    creativeDirection: {
      mediaRequired: false,
      mediaType: "none",
      mediaPromptOrBrief:
        "Platform-native creative direction unavailable for this platform. Operator decides whether to attach media.",
      mediaRiskNotes: [
        "No platform-specific risk notes available — operator must apply judgment.",
      ],
    },
    riskLevel: "medium",
    warnings: [
      `Platform "${input.platform}" is outside the platform-native engine — rich shaping not applied. Treat output as draft-only.`,
    ],
    transformationNotes: [
      `Platform "${input.platform}" rendered as a fallback envelope; no platform-native transformation was applied.`,
    ],
  };
}

/**
 * Re-export the dispatcher and active-provider helpers for callers
 * outside this module (e.g. the rewrite flow in F4.6).
 */
export { activeProvider };

function seededDraftFromInputs(
  input: GenerationInput,
  context: GenerationPromptContext,
): GenerationResult["draft"] {
  const seedLines: string[] = [];
  seedLines.push(`# ${input.topic.trim()}`);
  seedLines.push("");
  if (input.goal && input.goal.trim().length > 0) {
    seedLines.push(`> Goal: ${input.goal.trim()}`);
    seedLines.push("");
  }
  seedLines.push("(Seeded draft — Signal will fill this in once an AI provider is connected. For now, write the post here.)");
  if (input.sourceUrl) {
    seedLines.push("");
    seedLines.push(`Source: ${input.sourceUrl.trim()}`);
  }
  if (input.cta) {
    seedLines.push("");
    seedLines.push(`CTA shape: ${input.cta.trim()}`);
  }
  if (context.voiceProfile) {
    seedLines.push("");
    seedLines.push(`Voice reminder: ${context.voiceProfile.trim()}`);
  }
  return {
    title: input.topic.trim().slice(0, 120),
    bodyMarkdown: seedLines.join("\n"),
    summary: input.goal?.trim() || null,
    tags: [],
    ctaSuggestion: input.cta ?? null,
    schedulePreference: input.schedulePreference ?? null,
    generatedByProvider: false,
    safetyNotes: [],
  };
}

function emptyDraft(input: GenerationInput): GenerationResult["draft"] {
  return {
    title: input.topic.trim().slice(0, 120),
    bodyMarkdown: input.topic.trim(),
    summary: null,
    tags: [],
    ctaSuggestion: null,
    schedulePreference: null,
    generatedByProvider: false,
    safetyNotes: [],
  };
}

/**
 * Parse a provider response. Looks for a trailing `tags: a, b, c`
 * line on dev.to / Hashnode platforms and strips it from the body.
 * Everything else is returned verbatim.
 */
function parseDraft(
  body: string,
  input: GenerationInput,
  context: GenerationPromptContext,
): GenerationResult["draft"] {
  const trimmed = body.trim();
  let bodyMarkdown = trimmed;
  let tags: string[] = [];

  // dev.to / Hashnode trailing tag line.
  if (context.platform === "devto" || context.platform === "hashnode") {
    const m = trimmed.match(/\n+tags:\s*([^\n]+)\s*$/i);
    if (m) {
      tags = m[1]
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
        .slice(0, 5);
      bodyMarkdown = trimmed.slice(0, m.index).trim();
    }
  }

  // Pull a title from the first H1 if present; otherwise reuse topic.
  const titleMatch = bodyMarkdown.match(/^#\s+(.+)$/m);
  const title = titleMatch
    ? titleMatch[1].trim().slice(0, 250)
    : input.topic.trim().slice(0, 250);

  return {
    title,
    bodyMarkdown,
    summary: input.goal?.trim() || null,
    tags,
    ctaSuggestion: input.cta ?? null,
    schedulePreference: input.schedulePreference ?? null,
    generatedByProvider: true,
    safetyNotes: [],
  };
}

function detectSimilarTopic(
  topic: string,
  recent: string[],
): string | null {
  if (topic.length < SIMILARITY_MIN_TOPIC_LEN) return null;
  const t = topic.toLowerCase();
  // Soft heuristic — we don't have the permalinks' titles right
  // here, so the comparison is intentionally fuzzy: if any
  // permalink mentions a slug-ish substring of the topic, surface
  // a warning. Cheap, false-positives are acceptable since the
  // warning never blocks.
  const tokens = t
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter((s) => s.length >= 5);
  for (const url of recent) {
    const lc = url.toLowerCase();
    let hits = 0;
    for (const tok of tokens) {
      if (lc.includes(tok)) hits += 1;
      if (hits >= 2) {
        return "You recently published something similar. Consider a new angle.";
      }
    }
  }
  return null;
}
