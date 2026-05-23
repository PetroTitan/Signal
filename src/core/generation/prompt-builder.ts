/**
 * Phase F4.5 — prompt builder.
 *
 * Pure function. Given the GenerationPromptContext (identity +
 * inputs + platform), produces:
 *   - a `system` message describing voice, platform shape, safety
 *   - a `user` message containing the founder's topic, goal, CTA,
 *     and any source URL
 *
 * The provider layer in generate-draft.ts is the only thing that
 * sends these to an actual LLM. This module is intentionally pure
 * so future MCP / external Claude flows can read the same prompt
 * via getGenerationPrompt().
 *
 * Platform-specific shaping (length, threading, markdown vs plain
 * text) lives in the platform paragraph below — same rules the
 * transformers/* modules already enforce on the publish side.
 */

import { TONE_INSTRUCTIONS, describeSafetyRules } from "./safety-rules";
import type { GenerationPromptContext } from "./generation-types";

export interface GenerationPrompt {
  system: string;
  user: string;
}

export function buildGenerationPrompt(
  context: GenerationPromptContext,
): GenerationPrompt {
  const system = [
    `You are drafting a single post on behalf of ${
      context.identityDisplayName ?? "this founder identity"
    } for ${context.platformLabel}.`,
    "",
    "Voice profile (the operator's own words — match this voice closely):",
    context.voiceProfile?.trim() || "(no explicit voice profile — write as a calm, technical founder sharing a build update)",
    "",
    "Platform shape:",
    platformShape(context.platform),
    context.platformVoiceHint ? `Platform note: ${context.platformVoiceHint}` : "",
    "",
    "Tone rules:",
    ...TONE_INSTRUCTIONS.map((t) => `- ${t}`),
    "",
    "Safety rules:",
    describeSafetyRules(),
    "",
    "Recent topics already published by this identity (avoid repeating them — find a fresh angle):",
    context.recentTopics.length > 0
      ? context.recentTopics.map((t) => `- ${t}`).join("\n")
      : "(no recent publishes yet)",
    "",
    "Output format:",
    "Return only the post itself, in markdown. Do not include meta-commentary. Do not include 'Here is your draft' or similar.",
    "If the post is for Bluesky, write a single readable paragraph (or up to ~250 words for a short thread); the publisher will split it.",
    "For dev.to / Hashnode / Indie Hackers / Reddit, write a complete post including a short hook, body, and a calm CTA.",
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  const product = context.product
    ? [
        "Product context (the product this identity publishes for):",
        `- Name: ${context.product.name}`,
        context.product.domain ? `- Domain: ${context.product.domain}` : "",
        context.product.category
          ? `- Category: ${context.product.category}`
          : "",
        context.product.summary
          ? `- Summary: ${context.product.summary}`
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n")
    : "";

  const user = [
    `Topic / idea: ${context.input.topic}`,
    context.input.goal ? `Goal: ${context.input.goal}` : "",
    context.input.cta ? `Desired CTA shape: ${context.input.cta}` : "",
    context.input.sourceUrl
      ? `Source reference: ${context.input.sourceUrl}  (summarize cautiously; do not invent details; do not quote long copyrighted passages)`
      : "",
    context.input.toneAdjustment
      ? `Tone adjustment: ${context.input.toneAdjustment}`
      : "",
    context.input.schedulePreference
      ? `Schedule preference: ${context.input.schedulePreference}  (just a note; the founder will schedule manually)`
      : "",
    product,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

  return { system, user };
}

function platformShape(platform: string): string {
  switch (platform) {
    case "devto":
      return [
        "- 600–1500 words typical, markdown supported.",
        "- Short hook, 2–4 useful headings, practical lessons, calm closer.",
        "- Suggest 1–4 lowercase tags at the end of the response on a single line prefixed with `tags:` (e.g. `tags: founder, automation, publishing`).",
        "- Optional canonical URL if the founder is republishing.",
      ].join("\n");
    case "hashnode":
      return [
        "- Engineering-oriented, 600–1500 words.",
        "- Clear architecture framing, practical implementation notes, real tradeoffs.",
        "- Suggest 1–4 tags at the end of the response on a single line prefixed with `tags:`.",
      ].join("\n");
    case "bluesky":
      return [
        "- Short and conversational. Keep the whole post under ~280 characters when possible.",
        "- If the idea genuinely needs more space, write up to ~250 words as a single readable block; the publisher will split into a thread.",
        "- No headings, no markdown structure.",
        "- Sentences first; links second.",
      ].join("\n");
    case "indie_hackers":
      return [
        "- Founder update / build-in-public tone. 300–900 words.",
        "- Concrete numbers ONLY if the founder provided them in the topic/goal.",
        "- Acknowledge tradeoffs and constraints honestly.",
      ].join("\n");
    case "reddit":
      return [
        "- Community-native discussion-first tone, NOT a promo.",
        "- Read like someone genuinely participating in the subreddit, not marketing.",
        "- 200–600 words typical. Markdown supported but Reddit's flavor (no nested lists more than 1 level).",
      ].join("\n");
    case "x":
      return [
        "- Thread-shaped. Write the content as a sequence of short, specific posts; the splitter will divide it on sentence boundaries.",
        "- ~250 characters per post is a safe target.",
        "- No markdown formatting (X strips it). No hashtags. At most ONE external URL across the entire thread.",
        "- First post is the hook — make it land standalone if the reader doesn't read the rest.",
        "- Conversational, technical, specific. No engagement bait, no 'must read', no 'agree?' closers.",
        "- 3–7 thread parts is the calm range. 10+ parts feels desperate.",
      ].join("\n");
    case "linkedin":
      return [
        "- Calm founder reflection. 300–1200 words.",
        "- Short paragraphs (1–3 sentences). Lots of vertical breathing room.",
        "- Lead with the lesson or observation, not a personal-brand origin story.",
        "- No 'I'm thrilled / honored / humbled' openers. No 'agree?' closers. No fake inspiration.",
        "- Single optional link at the end if the post is summarizing a public URL.",
        "- Operational specifics over abstraction. Real tradeoffs over advice.",
      ].join("\n");
    default:
      return "- Calm, founder-shaped post in markdown.";
  }
}
