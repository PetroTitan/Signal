import type { AiProvider, AiResult } from "./ai-provider";
import type { AiUseCase } from "./ai-use-cases";
import type { AiInputFor } from "./prompt-contracts";
import type {
  CommentPolishOutput,
  ConvertToCommentOutput,
  DraftVariantOutput,
  GenerateTitleOptionsOutput,
  InsightExtractionOutput,
  PlatformAdaptationOutput,
  RemovePromotionalToneOutput,
  RewriteOutput,
  RiskExplanationOutput,
  SummarizeOpportunityOutput,
} from "./structured-outputs";
import { aiError } from "./ai-errors";
import { quickSafetyCheck } from "./ai-safety-policy";
import { isAllowedUseCase } from "./ai-use-cases";

export class MockAiProvider implements AiProvider {
  readonly meta = {
    id: "mock_local_preview",
    label: "Local preview",
    mode: "local_preview" as const,
    connected: false,
    notes: [
      "Deterministic, runs entirely in-browser.",
      "No external calls. No tokens. No telemetry.",
      "Output quality is approximate; intended for shape, not polish.",
    ],
  };

  async generate<U extends AiUseCase>(
    useCase: U,
    input: AiInputFor<U>,
  ): Promise<AiResult<U>> {
    if (!isAllowedUseCase(useCase)) {
      return { ok: false, error: aiError("use_case_blocked") };
    }
    try {
      const payload = dispatch(useCase, input);
      return { ok: true, payload } as AiResult<U>;
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      return { ok: false, error: aiError("internal", message) };
    }
  }
}

function dispatch<U extends AiUseCase>(
  useCase: U,
  input: AiInputFor<U>,
): unknown {
  switch (useCase) {
    case "rewrite_softer":
      return doRewriteSofter(input as AiInputFor<"rewrite_softer">);
    case "remove_promotional_tone":
      return doRemovePromotionalTone(
        input as AiInputFor<"remove_promotional_tone">,
      );
    case "convert_post_to_comment":
      return doConvertPostToComment(
        input as AiInputFor<"convert_post_to_comment">,
      );
    case "comment_polish":
      return doCommentPolish(input as AiInputFor<"comment_polish">);
    case "draft_variant":
      return doDraftVariant(input as AiInputFor<"draft_variant">);
    case "platform_adaptation":
      return doPlatformAdaptation(input as AiInputFor<"platform_adaptation">);
    case "summarize_opportunity":
      return doSummarizeOpportunity(
        input as AiInputFor<"summarize_opportunity">,
      );
    case "explain_risk":
      return doExplainRisk(input as AiInputFor<"explain_risk">);
    case "generate_title_options":
      return doGenerateTitleOptions(input as AiInputFor<"generate_title_options">);
    case "insight_extraction":
      return doInsightExtraction(input as AiInputFor<"insight_extraction">);
    default:
      throw new Error(`Unsupported use case: ${useCase}`);
  }
}

function doRewriteSofter(input: AiInputFor<"rewrite_softer">): RewriteOutput {
  const body = softenText(input.text);
  return {
    text: body,
    changes_made: collectSoftenChanges(input.text, body),
    risk_reduction_notes: [
      "Replaced absolute claims with hedged phrasing.",
      "Removed launch-spam language where present.",
    ],
    remaining_warnings:
      quickSafetyCheck(body).flags.length > 0
        ? ["Output still includes phrasing that may need human review."]
        : [],
  };
}

function doRemovePromotionalTone(
  input: AiInputFor<"remove_promotional_tone">,
): RemovePromotionalToneOutput {
  const text = softenText(input.text);
  const removed = collectSoftenChanges(input.text, text);
  return {
    text,
    removed_phrases: removed,
    kept_intent: extractIntent(input.text),
  };
}

function doConvertPostToComment(
  input: AiInputFor<"convert_post_to_comment">,
): ConvertToCommentOutput {
  const stripped = softenText(input.postBody).replace(/\n+/g, " ").trim();
  const sentence = firstSentence(stripped);
  return {
    comment_text: `One thing we've seen: ${sentence}`,
    removed_cta: Boolean(input.cta),
    removed_link: input.hasLink,
    rationale:
      "Converted to a comment-shaped contribution. CTAs and outbound links were stripped to fit comment-first norms.",
  };
}

function doCommentPolish(
  input: AiInputFor<"comment_polish">,
): CommentPolishOutput {
  const polished = softenText(input.draftBody.trim());
  const fitOk =
    /\?\s*$/.test(input.threadTitle) ||
    input.threadSummary.length > 40;
  return {
    comment_text: polished,
    relevance_reason: fitOk
      ? "Thread invites discussion; polished comment fits."
      : "Thread looks thin; consider skipping.",
    promotional_risk: quickSafetyCheck(polished).blocked ? "high" : "low",
    should_post: fitOk,
    skip_reason: fitOk ? undefined : "Thread context too thin to add value.",
  };
}

function doDraftVariant(
  input: AiInputFor<"draft_variant">,
): DraftVariantOutput {
  const body = softenText(input.insightBody);
  const allowedCta = input.allowedCtaCopy?.[0] ?? null;
  return {
    title: input.insightTitle,
    body,
    platform: input.platform,
    content_type: input.contentType,
    tone: "calm",
    cta_level: allowedCta ? "soft" : "none",
    link_recommendation:
      input.platform === "reddit"
        ? "no_link"
        : allowedCta
          ? "soft_link"
          : "no_link",
    risk_notes: [
      "Mock provider output. Run the risk engine before scheduling.",
    ],
  };
}

function doPlatformAdaptation(
  input: AiInputFor<"platform_adaptation">,
): PlatformAdaptationOutput {
  return {
    platform: input.targetPlatforms[0] ?? "x",
    variants: input.targetPlatforms.map((platform) => ({
      title: input.insightTitle,
      body: softenText(input.insightBody),
      platform,
      content_type:
        platform === "linkedin"
          ? "long_form_article"
          : platform === "reddit"
            ? "discussion_post"
            : "discussion_post",
      tone: "calm",
      cta_level: "none",
      link_recommendation: "no_link",
      risk_notes: [
        "Mock adaptation. Approve in the queue with full risk scoring.",
      ],
    })),
  };
}

function doSummarizeOpportunity(
  input: AiInputFor<"summarize_opportunity">,
): SummarizeOpportunityOutput {
  return {
    one_line: trim(input.opportunityTitle, 100),
    rationale: trim(input.rationale, 200),
    suggested_action: "Open the approval queue and review the draft variant.",
  };
}

function doExplainRisk(
  input: AiInputFor<"explain_risk">,
): RiskExplanationOutput {
  return {
    summary: `Risk ${input.risk.level} (${input.risk.score}).`,
    reasons: input.risk.reasons.slice(0, 4),
    recommendation: input.risk.recommendation,
    blocked_actions:
      input.risk.level === "blocked"
        ? ["publish_now", "approve_without_changes"]
        : [],
  };
}

function doGenerateTitleOptions(
  input: AiInputFor<"generate_title_options">,
): GenerateTitleOptionsOutput {
  const seed = firstSentence(input.body).replace(/\.$/, "");
  const count = Math.min(input.count ?? 3, 4);
  const options = [
    seed,
    `What we noticed: ${trim(seed.toLowerCase(), 60)}`,
    `${trim(seed, 60)} — operator notes`,
    `One quiet pattern: ${trim(seed.toLowerCase(), 60)}`,
  ].slice(0, count);
  return { options };
}

function doInsightExtraction(
  input: AiInputFor<"insight_extraction">,
): InsightExtractionOutput {
  const text = input.rawObservation.trim();
  const title = firstSentence(text).slice(0, 80);
  return {
    title,
    core_insight: text,
    summary: trim(text, 160),
    category: "founder_observation",
    candidate_audiences: ["founders", "operators"],
  };
}

// --- pure helpers ---

const softeners: [RegExp, string][] = [
  [/\bbest\b/gi, "a useful"],
  [/\bguaranteed\b/gi, "designed for"],
  [/\bmade me cry\b/gi, "was frustrating to use"],
  [/\b100%\b/gi, "in our experience"],
  [/\bgo viral\b/gi, "reach a real audience"],
  [/\bsecret\b/gi, "underused"],
  [/\bdisrupt\b/gi, "rethink"],
  [/\bintroducing\b/gi, "sharing"],
  [/\blaunching\b/gi, "shipping"],
  [/\b🚀\b/g, ""],
];

function softenText(text: string): string {
  return softeners.reduce(
    (out, [re, replacement]) => out.replace(re, replacement),
    text,
  );
}

function collectSoftenChanges(before: string, after: string): string[] {
  const changes: string[] = [];
  for (const [re] of softeners) {
    const matches = before.match(re);
    if (matches && matches.length > 0 && !after.match(re)) {
      changes.push(`Softened: ${matches[0]}`);
    }
  }
  if (changes.length === 0 && before.length !== after.length) {
    changes.push("Tightened phrasing.");
  }
  return changes;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^[^.!?]+[.!?]?/);
  return m ? m[0].trim() : trimmed.slice(0, 120);
}

function trim(text: string, n: number): string {
  if (text.length <= n) return text;
  return text.slice(0, n - 1).trimEnd() + "…";
}

function extractIntent(text: string): string {
  return firstSentence(text);
}
