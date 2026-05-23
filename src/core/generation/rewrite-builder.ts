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
  to_x_thread:
    "Adapt this content as an X thread. 3–7 short posts (~250 chars each). No markdown, no hashtags, max ONE external URL across the whole thread. First post is the standalone hook. No engagement bait endings.",
  to_linkedin_post:
    "Adapt this content as a LinkedIn post. 300–1200 words. Short paragraphs (1–3 sentences each) with vertical breathing room. Lead with the operational lesson, not personal-brand framing. No 'I'm thrilled', 'humbled to announce', or 'agree?' patterns. Optional single trailing link.",
  to_youtube_description:
    "Adapt this content as a YouTube video description. 100–400 words, plain text, 2–4 paragraphs. Suggest 1–4 H2 headings inline ('## Section title') that Signal will extract as chapter labels. End with a single line 'tags: a, b, c' (1–4 lowercase tags). No 'don't forget to subscribe' / 'smash the like' / algorithm-bait language. First line is the video title (~45–75 chars, no ALL CAPS).",
  to_threads_post:
    "Adapt this content as a single Threads post. 200–400 characters target, 500 hard limit. Plain text, sentences first, conversational. At most one external URL. No hashtag spam. No 'this blew up' / 'comment below' / 'follow for daily' patterns.",
  to_instagram_caption:
    "Adapt this content as an Instagram caption for an image or carousel post. 200–1200 chars target. Short paragraphs, sparse optional emoji. End with 1–4 specific lowercase hashtags on a 'tags: ...' line. No 'link in bio' / 'double tap' / 'manifest' / '7-figure' / 'DM me' patterns. Caption supports the image; it doesn't replace it.",
  improve_headline:
    "Improve the post's headline ONLY. Return a single line of plain text — no markdown, no quotes, no leading hash. Same topic, sharper hook. Do not return the body.",
};

const TARGET_PLATFORM_HINT: Record<RewriteAction, string | null> = {
  to_bluesky_thread: "bluesky",
  to_devto_article: "devto",
  to_x_thread: "x",
  to_linkedin_post: "linkedin",
  to_youtube_description: "youtube",
  to_threads_post: "threads",
  to_instagram_caption: "instagram",
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
