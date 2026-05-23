/**
 * Phase F4.6 — rewrite prompt builder.
 *
 * Pure function. Given an existing draft body + an editorial action
 * + the publishing identity context, produces a system+user prompt
 * the provider can act on. The same safety rules from generation
 * apply (re-enforced post-response by evaluateDraftSafety).
 *
 * The prompt always tells the model:
 *   - keep the founder's voice
 *   - never invent metrics, customer counts, revenue, partnerships
 *   - return ONLY the rewritten content (no meta-commentary, no
 *     "here is your rewrite", no preambles)
 *
 * For "improve_headline" we ask the model to return ONLY the new
 * title on the first line; the caller pulls that line and discards
 * the rest.
 */

import { TONE_INSTRUCTIONS, describeSafetyRules } from "./safety-rules";
import { resolveIdentityPlatformGuidance } from "@/core/publishing/platform-guidance";
import type { PublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import type { RewriteAction } from "./rewrite-types";

export interface RewritePromptInput {
  identityContext: PublishingIdentityContext;
  currentTitle: string | null;
  currentBody: string;
  /** Original target platform of the post. Used for non-adapt rewrites. */
  platform: string;
  action: RewriteAction;
}

export interface RewritePrompt {
  system: string;
  user: string;
  /** True when the response is a single headline line, not a full body. */
  expectsHeadlineOnly: boolean;
}

const ACTION_INSTRUCTION: Record<RewriteAction, string> = {
  rewrite:
    "Rewrite the post end-to-end while preserving the underlying point. Keep the same target platform and length range.",
  shorter:
    "Tighten the post. Cut filler. Aim for roughly half the original length without dropping the substance.",
  more_technical:
    "Make the post more technical. Add a real architecture detail, a tradeoff, or an implementation note. Do not invent specifics — if a detail isn't supported by the original, omit it rather than fabricate.",
  more_founder:
    "Rewrite in a calm founder-builder voice — concrete, operational, honest about constraints. Less marketing register. No hype words.",
  less_promotional:
    "Soften promotional language. Remove product pitching, replace 'we built' with build-update framing, and turn any CTA into an invitation rather than a sell.",
  to_bluesky_thread:
    "Adapt this content for Bluesky as a single readable post or a short thread (max ~280 characters per part). Plain text, no markdown structure, sentences first.",
  to_devto_article:
    "Adapt this content as a dev.to article. 600–1500 words. Markdown with 2–4 useful headings, practical lessons, calm closer. End with a single line `tags: a, b, c` listing 1–4 relevant tags.",
  improve_headline:
    "Improve the post's headline ONLY. Return a single line of plain text — no markdown, no quotes, no leading hash. Same topic, sharper hook. Do not return the body.",
};

const TARGET_PLATFORM_HINT: Record<RewriteAction, string | null> = {
  to_bluesky_thread: "bluesky",
  to_devto_article: "devto",
  rewrite: null,
  shorter: null,
  more_technical: null,
  more_founder: null,
  less_promotional: null,
  improve_headline: null,
};

export function buildRewritePrompt(input: RewritePromptInput): RewritePrompt {
  const expectsHeadlineOnly = input.action === "improve_headline";

  // Resolve the platform the rewrite should target. Adapt-actions
  // override the original platform; everything else keeps it.
  const adaptedPlatform = TARGET_PLATFORM_HINT[input.action];
  const targetPlatform = adaptedPlatform ?? input.platform;
  const targetGuidance = resolveIdentityPlatformGuidance(targetPlatform);
  const targetLabel = targetGuidance?.label ?? targetPlatform;

  const voiceProfile = input.identityContext.voiceProfile?.trim();
  const productLine = input.identityContext.associatedProduct
    ? `Product context: ${input.identityContext.associatedProduct.name}${
        input.identityContext.associatedProduct.summary
          ? ` — ${input.identityContext.associatedProduct.summary}`
          : ""
      }`
    : null;

  const system = [
    `You are editing a draft post on behalf of ${
      input.identityContext.displayName ?? "this founder identity"
    } for ${targetLabel}.`,
    "",
    "Voice profile (match closely — the operator's own words):",
    voiceProfile && voiceProfile.length > 0
      ? voiceProfile
      : "(no explicit voice profile — keep a calm, technical founder-builder voice)",
    "",
    productLine ?? "",
    "",
    `Editorial action: ${ACTION_INSTRUCTION[input.action]}`,
    "",
    "Tone rules:",
    ...TONE_INSTRUCTIONS.map((t) => `- ${t}`),
    "",
    "Safety rules:",
    describeSafetyRules(),
    "",
    expectsHeadlineOnly
      ? "Output format: return ONLY the new headline on a single line. No quotes, no leading '#', no body, no meta-commentary."
      : "Output format: return ONLY the rewritten post itself, in markdown if the platform supports it, plain text otherwise. No meta-commentary. No 'Here is your rewrite'.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const user = [
    input.currentTitle ? `Current title:\n${input.currentTitle}` : "",
    "",
    "Current body:",
    input.currentBody,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return { system, user, expectsHeadlineOnly };
}
