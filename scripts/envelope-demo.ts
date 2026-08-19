/**
 * Demo: assemble the full PlatformNativeDraft envelope from a fake
 * GenerationDraft + identity context, for the six platforms the
 * user asked about.
 *
 * Not part of the build. Run with:
 *   npx tsx scripts/envelope-demo.ts
 */

import { assemblePlatformNativeDraft } from "../src/core/generation/assemble-platform-native-result";
import type { GenerationDraft, GenerationInput } from "../src/core/generation/generation-types";
import type { PublishingIdentityContext } from "../src/core/publishing/publishing-identity-context";
import type { FounderPlatform } from "../src/core/publishing/platform-guidance";

const PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "x",
  "linkedin",
  "telegram",
  "instagram",
  "youtube",
];

const CANONICAL_IDEA =
  "We moved refresh-token storage from plaintext to AES-GCM envelope " +
  "encryption with per-workspace keys. Incident rate from rotated keys " +
  "dropped to zero.";

const ctx = (platform: FounderPlatform): PublishingIdentityContext => ({
  identityId: "id-1",
  platform,
  platformLabel: platform,
  displayName: "WebmasterID",
  handle: "webmasterid",
  voiceProfile: "Calm, technical founder sharing build updates.",
  sourceWebsiteUrl: null,
  referenceUrls: [],
  ageDays: 120,
  lifecycleStatus: "active",
  associatedProduct: {
    id: "p1",
    name: "Signal",
    domain: "signal.webmasterid.com",
    summary: "Publishing operations for builders.",
    category: "developer-tools",
  },
  publishingHistory: [],
  platformGuidance: null,
});

const genInput = (platform: FounderPlatform): GenerationInput => ({
  weeklyPlanId: null,
  identityId: "id-1",
  platform,
  productId: null,
  topic: CANONICAL_IDEA,
  goal: "share the engineering observation",
  cta: null,
  sourceUrl: null,
  toneAdjustment: null,
  schedulePreference: null,
});

const fakeDraft = (platform: FounderPlatform): GenerationDraft => ({
  title:
    platform === "reddit" || platform === "devto" || platform === "hashnode" || platform === "youtube"
      ? "Refresh-token storage rewrite"
      : null,
  bodyMarkdown:
    "Refresh-token storage and incident rate are linked.\n\n" +
    "We moved to AES-GCM envelope encryption with per-workspace keys. " +
    "The migration took two weeks; the biggest wrinkle was making the " +
    "key-rotation handler idempotent.\n\n" +
    "Incident rate from rotated keys dropped to zero since the move.",
  summary: null,
  tags: [],
  ctaSuggestion: null,
  schedulePreference: null,
  generatedByProvider: true,
  safetyNotes: [],
});

for (const p of PLATFORMS) {
  const env = assemblePlatformNativeDraft({
    identityContext: ctx(p),
    platform: p,
    generation: genInput(p),
    draft: fakeDraft(p),
  });
  console.log("=".repeat(72));
  console.log(`PLATFORM: ${p}`);
  console.log("=".repeat(72));
  console.log(`title:   ${env.title}`);
  console.log(`format:  ${env.format}`);
  console.log(`risk:    ${env.riskLevel}`);
  console.log(`hook:    ${env.hook}`);
  console.log(`cta:     ${env.cta ?? "(none)"}`);
  console.log("");
  console.log("creativeDirection:");
  console.log(
    `  mediaRequired: ${env.creativeDirection.mediaRequired}` +
      `  ·  type: ${env.creativeDirection.mediaType}`,
  );
  console.log(
    "  brief: " + env.creativeDirection.mediaPromptOrBrief.slice(0, 200),
  );
  console.log("  risk notes:");
  for (const n of env.creativeDirection.mediaRiskNotes.slice(0, 3)) {
    console.log("    - " + n);
  }
  console.log("");
  console.log("warnings:");
  if (env.warnings.length === 0) console.log("  (none)");
  for (const w of env.warnings) console.log("  - " + w);
  console.log("");
  console.log("transformationNotes:");
  for (const n of env.transformationNotes) console.log("  - " + n);
  console.log("");
  console.log("body (first 200 chars):");
  console.log("  " + env.body.slice(0, 200).replace(/\n/g, " "));
  console.log("");
}
