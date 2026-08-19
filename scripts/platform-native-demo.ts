/**
 * Demo: same canonical idea → eight platform-native scaffolds.
 *
 * Not part of the build. Run with:
 *   npx tsx scripts/platform-native-demo.ts
 *
 * Prints, per platform: format · CTA style · creativeDirection ·
 * transformationNotes. Demonstrates that the engine emits
 * materially different shaping per platform from the same input.
 */

import {
  adaptIdeaForPlatform,
  type AdaptIdeaInput,
} from "../src/core/platform-native";
import type { FounderPlatform } from "../src/core/publishing/platform-guidance";

const PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "x",
  "bluesky",
  "linkedin",
  "telegram",
  "devto",
  "instagram",
  "youtube",
];

const CANONICAL_IDEA =
  "We moved refresh-token storage from plaintext to AES-GCM envelope " +
  "encryption with per-workspace keys. Incident rate from rotated keys " +
  "dropped to zero. The migration took two weeks; the biggest wrinkle " +
  "was making the key-rotation handler idempotent.";

const baseInput = (platform: FounderPlatform): AdaptIdeaInput => ({
  canonicalIdea: CANONICAL_IDEA,
  identity: {
    displayName: "WebmasterID",
    handle: "webmasterid",
    voiceProfile:
      "Calm, technical founder sharing operational build updates.",
    ageDays: 120,
    status: "active",
  },
  platform,
  product: {
    name: "Signal",
    domain: "signal.webmasterid.com",
    summary: "Publishing operations for builders.",
    category: "developer-tools",
  },
  goal: "share the engineering observation",
  link: null,
  sourceArticle: null,
  launchContext: null,
});

for (const p of PLATFORMS) {
  const out = adaptIdeaForPlatform(baseInput(p));
  console.log("=".repeat(72));
  console.log(`PLATFORM: ${p}`);
  console.log("=".repeat(72));
  console.log(`Format: ${out.scaffold.format}`);
  console.log(`Risk:   ${out.scaffold.riskLevel}`);
  console.log("");
  console.log("CTA instruction:");
  console.log("  " + out.ctaInstruction);
  console.log("");
  console.log("Creative direction:");
  console.log(
    `  mediaRequired: ${out.creativeDirection.mediaRequired}` +
      `  ·  type: ${out.creativeDirection.mediaType}`,
  );
  console.log(
    "  brief: " + out.creativeDirection.mediaPromptOrBrief.slice(0, 220),
  );
  console.log("");
  console.log("Transformation notes:");
  for (const note of out.scaffold.transformationNotes) console.log("  - " + note);
  console.log("");
}
