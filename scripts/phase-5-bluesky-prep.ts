/**
 * Phase 5.1 — Bluesky test-draft prep (dry-run, no I/O, no DB).
 *
 * Calls the SAME assemblePlatformNativeDraft + preview-rendering
 * code paths the production pipeline uses, with the exact test
 * topic the operator approved. Produces:
 *   - the structured PlatformNativeDraft envelope
 *   - the rendered preview HTML
 *   - a 10-point validation report
 *
 * This script runs locally because the production pipeline lives
 * behind an authenticated Next.js server action that requires:
 *   - a real Supabase identity row
 *   - a real workspace membership
 *   - an authenticated operator session
 *
 * None of those are reachable from this Bash environment. The dry-
 * run validates the engine outputs (which are deterministic and
 * platform-encoded) so the operator knows exactly what to expect
 * when they generate the same draft in production.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assemblePlatformNativeDraft } from "../src/core/generation/assemble-platform-native-result";
import { PlatformNativePreview } from "../src/app/(app)/accounts/_platform-native-preview";
import type {
  GenerationDraft,
  GenerationInput,
} from "../src/core/generation/generation-types";
import type { PublishingIdentityContext } from "../src/core/publishing/publishing-identity-context";

// =====================================================================
// Operator-supplied test topic — verbatim from Phase 5.1 brief.
// =====================================================================

const TOPIC =
  "Running a small publishing-infrastructure test from Signal today. " +
  "Goal: verify that the post is sent from the correct signed-in " +
  "identity, not a workspace-wide credential.";

// =====================================================================
// Identity context — shape matches what getPublishingIdentityContext
// returns in production. ageDays=120 + lifecycleStatus="active"
// reflect a non-warming Bluesky identity (typical operator state).
// =====================================================================

const identityContext: PublishingIdentityContext = {
  identityId: "<production-identity-id>",
  platform: "bluesky",
  platformLabel: "Bluesky",
  displayName: "<operator-display-name>",
  handle: "<operator-handle>",
  voiceProfile:
    "Calm, technical founder. Operational observations over hype.",
  sourceWebsiteUrl: null,
  referenceUrls: [],
  ageDays: 120,
  lifecycleStatus: "active",
  associatedProduct: null,
  publishingHistory: [],
  platformGuidance: null,
};

const generationInput: GenerationInput = {
  weeklyPlanId: null,
  identityId: identityContext.identityId,
  platform: "bluesky",
  productId: null,
  topic: TOPIC,
  goal: null,
  cta: null,
  sourceUrl: null,
  toneAdjustment: null,
  schedulePreference: null,
};

// =====================================================================
// Seed the draft body. In production, the LLM provider expands the
// topic into a Bluesky-shaped paragraph. In this dry-run (no LLM),
// the seeded path uses the topic verbatim — which happens to be a
// usable Bluesky post on its own. This is the SAME path
// generate-draft.ts takes when readGenerationProviderStatus()
// returns { available: false }.
// =====================================================================

const seededDraft: GenerationDraft = {
  title: null,
  bodyMarkdown: TOPIC,
  summary: null,
  tags: [],
  ctaSuggestion: null,
  schedulePreference: null,
  generatedByProvider: false,
  safetyNotes: [],
};

// =====================================================================
// Run the production assemble helper. Deterministic; identical to
// what generateDraft does on the seeded path.
// =====================================================================

const envelope = assemblePlatformNativeDraft({
  identityContext,
  platform: "bluesky",
  generation: generationInput,
  draft: seededDraft,
});

// =====================================================================
// Render the preview the operator will see in the compose sheet.
// =====================================================================

const previewHtml = renderToStaticMarkup(
  React.createElement(PlatformNativePreview, { draft: envelope }),
);

// =====================================================================
// Validation report
// =====================================================================

interface Check {
  id: number;
  description: string;
  expected: string;
  actual: string;
  passed: boolean;
}

const checks: Check[] = [];

function check(
  id: number,
  description: string,
  expected: string,
  actualValue: unknown,
  predicate: (v: unknown) => boolean,
): void {
  const passed = predicate(actualValue);
  checks.push({
    id,
    description,
    expected,
    actual: JSON.stringify(actualValue).slice(0, 200),
    passed,
  });
}

// 1. Generated envelope exists
check(
  1,
  "Generated envelope exists",
  "PlatformNativeDraft object with required fields",
  envelope,
  (v) => v !== null && typeof v === "object",
);

// 2. creativeDirection exists
check(
  2,
  "creativeDirection exists",
  "non-null object",
  envelope.creativeDirection,
  (v) => v !== null && typeof v === "object",
);

// 3. mediaRequired=false (Bluesky)
check(
  3,
  "mediaRequired=false (Bluesky text-only)",
  "false",
  envelope.creativeDirection.mediaRequired,
  (v) => v === false,
);

// 4. Preview renders correctly — non-empty markup, contains key
//    operator-facing sections
check(
  4,
  "Preview renders correctly",
  "HTML markup containing platform header, body, media block",
  previewHtml,
  (v) =>
    typeof v === "string" &&
    v.includes("Preview for Bluesky") &&
    v.includes("Body") &&
    v.includes("Media"),
);

// 5. Copy buttons render — at minimum body + media-brief
check(
  5,
  "Copy buttons render (body + media brief)",
  "aria-label markers for body and brief",
  previewHtml,
  (v) =>
    typeof v === "string" &&
    v.includes('aria-label="Copy body"') &&
    v.includes('aria-label="Copy brief"'),
);

// 6. Plan-item creation path — dry-run cannot exercise the action,
//    but the envelope structure is what _generate-draft-action writes
//    to metadata.platform_native_draft. Confirm the persisted shape
//    is present and serializes cleanly.
check(
  6,
  "Plan-item creation: envelope ready for metadata.platform_native_draft",
  "Serializable envelope with required keys",
  Object.keys(envelope).sort(),
  (v) =>
    Array.isArray(v) &&
    ["body", "cta", "creativeDirection", "format", "hook", "platform", "riskLevel", "title", "transformationNotes", "warnings"].every(
      (k) => (v as string[]).includes(k),
    ),
);

// 7. Deep-link URL contract — confirm the compose-sheet source
//    constructs /weekly-plan?focus=<itemId>. Same source-level
//    guard the regression test enforces.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const sheetSrc = readFileSync(
  join(process.cwd(), "src", "app", "(app)", "accounts", "_generate-draft-sheet.tsx"),
  "utf8",
);
check(
  7,
  "Deep-link URL contract: /weekly-plan?focus=<itemId>",
  "encodeURIComponent(safe.itemId) interpolated into URL",
  sheetSrc,
  (v) =>
    typeof v === "string" &&
    /\/weekly-plan\?focus=\$\{encodeURIComponent\(safe\.itemId\)\}/.test(v),
);

// 8. No internal field names in rendered text (strip data-* attrs,
//    then scan)
const visibleText = previewHtml.replace(/data-[a-z-]+="[^"]*"/g, "");
const forbiddenInternals = [
  "creativeDirection",
  "transformationNotes",
  "mediaRequired",
  "platformNativeDraft",
  "api_key_verify",
  "personal_api_key",
];
check(
  8,
  "No internal field names leak into UI",
  "None of: " + forbiddenInternals.join(", "),
  forbiddenInternals.filter((t) => visibleText.includes(t)),
  (v) => Array.isArray(v) && v.length === 0,
);

// 9. No fake-visual implication
const fakeVisualPhrases = [
  "the image shows",
  "as you can see in",
  "the screenshot shows",
  "the visual demonstrates",
  "in the attached",
];
const lowered = previewHtml.toLowerCase();
check(
  9,
  "No fake screenshot/visual language appears",
  "Preview HTML contains none of the fake-visual phrases",
  fakeVisualPhrases.filter((p) => lowered.includes(p)),
  (v) => Array.isArray(v) && v.length === 0,
);

// 10. No legacy fallback path used — the envelope itself doesn't
//     trigger a publish, but we confirm the orchestrator code path
//     for Bluesky reaches publishToBlueskyAsIdentity (identity-
//     scoped) before the legacy fallback. This is a static check
//     against the orchestrator source.
const orchestratorSrc = readFileSync(
  join(process.cwd(), "src", "core", "publishing", "bluesky-publish-orchestrator.ts"),
  "utf8",
);
check(
  10,
  "Legacy-fallback gate: identity-scoped path runs first; workspace fallback only on isBlueskyLegacyFallbackEnabled",
  "publishToBlueskyAsIdentity called before publishToBluesky; fallback gated",
  orchestratorSrc,
  (v) =>
    typeof v === "string" &&
    v.indexOf("publishToBluesky(") > v.indexOf("isBlueskyLegacyFallbackEnabled") &&
    v.indexOf("publishToBlueskyAsIdentity") < v.indexOf("isBlueskyLegacyFallbackEnabled"),
);

// =====================================================================
// Output
// =====================================================================

console.log("=".repeat(72));
console.log("Phase 5.1 — Bluesky test-draft prep (dry-run)");
console.log("=".repeat(72));
console.log("");
console.log("TOPIC (operator-supplied, verbatim):");
console.log("  " + TOPIC);
console.log("");
console.log("ENVELOPE:");
console.log(`  platform           : ${envelope.platform}`);
console.log(`  format             : ${envelope.format}`);
console.log(`  title              : ${envelope.title ?? "(none)"}`);
console.log(`  hook               : ${envelope.hook}`);
console.log(`  cta                : ${envelope.cta ?? "(none)"}`);
console.log(`  riskLevel          : ${envelope.riskLevel}`);
console.log(`  warnings           : ${envelope.warnings.length === 0 ? "(none)" : envelope.warnings.join(" | ")}`);
console.log(`  transformationNotes:`);
for (const n of envelope.transformationNotes) console.log("    - " + n);
console.log("");
console.log("CREATIVE DIRECTION:");
console.log(`  mediaRequired      : ${envelope.creativeDirection.mediaRequired}`);
console.log(`  mediaType          : ${envelope.creativeDirection.mediaType}`);
console.log(`  brief              : ${envelope.creativeDirection.mediaPromptOrBrief}`);
console.log(`  risk notes         :`);
for (const r of envelope.creativeDirection.mediaRiskNotes) console.log("    - " + r);
console.log("");
console.log("VALIDATION REPORT:");
console.log("");
let allPassed = true;
for (const c of checks) {
  const mark = c.passed ? "✅" : "❌";
  console.log(`  ${mark}  ${c.id}. ${c.description}`);
  console.log(`         expected: ${c.expected}`);
  console.log(`         actual  : ${c.actual}`);
  console.log("");
  if (!c.passed) allPassed = false;
}

console.log("=".repeat(72));
console.log(
  allPassed
    ? "RESULT: all 10 validations PASSED. Draft is ready for production preview + operator approval."
    : "RESULT: one or more validations FAILED — see above. Do NOT proceed.",
);
console.log("=".repeat(72));

process.exit(allPassed ? 0 : 1);
