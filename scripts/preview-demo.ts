/**
 * Demo: render the PlatformNativePreview component for the six
 * platforms the user cares about, write to text snapshots in the
 * console. Not part of the build.
 *
 * Run: npx tsx scripts/preview-demo.ts
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformNativePreview } from "../src/app/(app)/accounts/_platform-native-preview";
import { assemblePlatformNativeDraft } from "../src/core/generation/assemble-platform-native-result";
import type {
  GenerationDraft,
  GenerationInput,
} from "../src/core/generation/generation-types";
import type { PublishingIdentityContext } from "../src/core/publishing/publishing-identity-context";
import type { FounderPlatform } from "../src/core/publishing/platform-guidance";

const PLATFORMS: FounderPlatform[] = [
  "reddit",
  "x",
  "linkedin",
  "telegram",
  "instagram",
  "youtube",
];

const IDEA =
  "We moved refresh-token storage from plaintext to AES-GCM envelope " +
  "encryption with per-workspace keys. Incident rate from rotated keys " +
  "dropped to zero.";

function ctx(platform: FounderPlatform): PublishingIdentityContext {
  return {
    identityId: "id-1",
    platform,
    platformLabel: platform,
    displayName: "WebmasterID",
    handle: "webmasterid",
    voiceProfile: null,
    sourceWebsiteUrl: null,
    referenceUrls: [],
    ageDays: 120,
    lifecycleStatus: "active",
    associatedProduct: {
      id: "p1",
      name: "Signal",
      domain: "signal.webmasterid.com",
      summary: null,
      category: "developer-tools",
    },
    publishingHistory: [],
    platformGuidance: null,
  };
}

function gen(platform: FounderPlatform): GenerationInput {
  return {
    weeklyPlanId: null,
    identityId: "id-1",
    platform,
    productId: null,
    topic: IDEA,
    goal: null,
    cta: null,
    sourceUrl: null,
    toneAdjustment: null,
    schedulePreference: null,
  };
}

function generated(platform: FounderPlatform): GenerationDraft {
  return {
    title:
      platform === "reddit" || platform === "youtube"
        ? "Refresh-token storage rewrite"
        : null,
    bodyMarkdown:
      "Refresh-token storage and incident rate are linked.\n\n" +
      "We moved to AES-GCM envelope encryption with per-workspace keys. " +
      "Migration took two weeks; the biggest wrinkle was an idempotent " +
      "key-rotation handler.\n\n" +
      "Incident rate from rotated keys dropped to zero since.",
    summary: null,
    tags: [],
    ctaSuggestion: null,
    schedulePreference: null,
    generatedByProvider: true,
    safetyNotes: [],
  };
}

// Strip HTML tags + collapse whitespace for a readable text snapshot.
function readable(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

for (const p of PLATFORMS) {
  const envelope = assemblePlatformNativeDraft({
    identityContext: ctx(p),
    platform: p,
    generation: gen(p),
    draft: generated(p),
  });
  const html = renderToStaticMarkup(
    React.createElement(PlatformNativePreview, { draft: envelope }),
  );
  console.log("=".repeat(72));
  console.log(`PLATFORM: ${p}`);
  console.log("=".repeat(72));
  console.log(readable(html));
  console.log("");
}
