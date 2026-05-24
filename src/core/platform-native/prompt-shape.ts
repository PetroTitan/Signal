/**
 * Build the per-platform prompt block from the style profile.
 *
 * This replaces the inline switch in src/core/generation/prompt-
 * builder.ts (`platformShape()`) when the adapter is invoked.
 * The legacy switch stays in place as a fallback so the existing
 * generation chain keeps working unchanged.
 *
 * Pure function. Returns a string the prompt builder pastes into
 * the system message.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import { getPlatformStyleProfile } from "./style-profiles";
import { getForbiddenPatterns } from "./forbidden-patterns";
import { getCreativeDirection } from "./creative-direction";

/**
 * Compose the platform-shape paragraph plus the forbidden-patterns
 * sub-list. The output is multi-line; the prompt builder pastes it
 * verbatim into the system message.
 */
export function buildPlatformShape(platform: FounderPlatform): string {
  const profile = getPlatformStyleProfile(platform);
  const forbidden = getForbiddenPatterns(platform);
  const creative = getCreativeDirection(platform);

  const lines: string[] = [];

  lines.push(`Platform shape for ${profile.platform}:`);
  lines.push(`- Tone: ${profile.tone}.`);
  lines.push(`- Density: ${profile.density}.`);
  lines.push(`- Pacing: ${profile.pacing}.`);
  lines.push(`- Structure: ${profile.structure}.`);
  lines.push(`- CTA style: ${profile.ctaStyle}`);
  lines.push(`- Length: ${profile.maxLengthGuidance}`);
  lines.push(`- Link policy: ${profile.linkPolicy}`);
  lines.push(`- Hashtag policy: ${profile.hashtagPolicy}`);
  lines.push(`- Emoji policy: ${profile.emojiPolicy}`);
  lines.push(`- Media policy: ${profile.mediaPolicy}`);

  if (profile.allowedPatterns.length > 0) {
    lines.push("");
    lines.push("Patterns that read native here:");
    for (const p of profile.allowedPatterns) lines.push(`- ${p}`);
  }

  if (forbidden.length > 0) {
    lines.push("");
    lines.push("Do NOT write any of these (they're platform-specific tells):");
    for (const p of forbidden) lines.push(`- ${p}`);
  }

  lines.push("");
  lines.push("Creative direction (the operator pairs the text with this):");
  lines.push(
    `- ${creative.mediaRequired ? "Media REQUIRED." : "Media optional."} Type: ${creative.mediaType}.`,
  );
  lines.push(`- Brief: ${creative.mediaPromptOrBrief}`);
  if (creative.mediaRiskNotes.length > 0) {
    lines.push("- Risk notes:");
    for (const note of creative.mediaRiskNotes) lines.push(`  - ${note}`);
  }

  return lines.join("\n");
}

/**
 * One-line CTA instruction the prompt builder pastes into the user
 * block. The platform profile owns the wording so CTA tone is
 * platform-native, not globally biased toward "invitation to discuss."
 */
export function buildCtaInstruction(platform: FounderPlatform): string {
  const profile = getPlatformStyleProfile(platform);
  return `CTA shape for ${profile.platform}: ${profile.ctaStyle}`;
}

/**
 * New-account safety addendum. The adapter folds this into the
 * prompt only when the identity is warming.
 */
export function buildNewAccountAddendum(platform: FounderPlatform): string {
  const profile = getPlatformStyleProfile(platform);
  if (profile.newAccountSafetyNotes.length === 0) return "";
  const lines = [
    "",
    "This identity is still warming — extra rules on top of the platform shape:",
    ...profile.newAccountSafetyNotes.map((n) => `- ${n}`),
  ];
  return lines.join("\n");
}
