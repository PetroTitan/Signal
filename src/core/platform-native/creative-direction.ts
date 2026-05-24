/**
 * Per-platform creative direction blueprints.
 *
 * Required output of the platform-native engine: every
 * PlatformNativeDraft carries a CreativeDirection so the operator
 * knows what visual to create alongside the text — and what NOT to
 * fake.
 *
 * The blueprints below are static defaults; the adapter layers on
 * launch / source / product context where it sharpens the prompt
 * for a specific draft.
 *
 * Rules baked in:
 *   - Do not fabricate screenshots or assert visuals exist.
 *   - Do not recommend generic stock images.
 *   - Charts of revenue / traction / users require operator-supplied
 *     numbers (never invented).
 *   - Instagram + YouTube require media — `mediaRequired: true`.
 *     Other platforms recommend media when it adds signal.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { CreativeDirection } from "./types";

const DO_NOT_FABRICATE: ReadonlyArray<string> = [
  "Do not generate or describe a screenshot that does not exist — operator must capture from the real product.",
  "Do not invent metrics, traction, or revenue numbers.",
];

const NO_GENERIC_STOCK: ReadonlyArray<string> = [
  "Do not use generic stock photography. Visual must be from the operator's product, workflow, or hand-made.",
];

// =====================================================================

const reddit: CreativeDirection = {
  mediaRequired: false,
  mediaType: "none",
  mediaPromptOrBrief:
    "Text-first. If you have a screenshot or diagram that proves the specific claim in the post, attach it; otherwise ship without media.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "Don't add a visual just to draw clicks — Reddit communities mark it as marketing.",
    "No stock images, no AI-generated illustrations.",
  ],
};

const x: CreativeDirection = {
  mediaRequired: false,
  mediaType: "diagram",
  mediaPromptOrBrief:
    "Optional. A single clean diagram, screenshot, or short visual that supports the core idea. The image should make the claim land faster — not decorate it.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "No quote-tweet meme images. No 'this is fine' style decoration.",
    "If the image carries a number, the operator supplied that number.",
  ],
};

const bluesky: CreativeDirection = {
  mediaRequired: false,
  mediaType: "screenshot",
  mediaPromptOrBrief:
    "Optional. A real screenshot or simple diagram if it adds substance. Often a calm Bluesky reflection ships text-only.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "Avoid engagement-bait visuals — Bluesky culture pushes back on them.",
  ],
};

const linkedin: CreativeDirection = {
  mediaRequired: false,
  mediaType: "carousel",
  mediaPromptOrBrief:
    "Document carousel (4–8 slides), clean diagram, or a real product screenshot. Each slide should advance the argument — not repeat it.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    ...NO_GENERIC_STOCK,
    "No quote graphics. No smiling-team stock. No corporate vector illustrations.",
    "If you carousel revenue / users / growth: operator-supplied numbers only.",
  ],
};

const threads: CreativeDirection = {
  mediaRequired: false,
  mediaType: "static_image",
  mediaPromptOrBrief:
    "Optional. A simple image or behind-the-scenes screenshot if it adds substance. Lightweight, not polished.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    ...NO_GENERIC_STOCK,
  ],
};

const instagram: CreativeDirection = {
  mediaRequired: true,
  mediaType: "carousel",
  mediaPromptOrBrief:
    "Visual REQUIRED. Pick one: (a) carousel 4–10 slides of the operator's actual screens / workflow / artifacts, (b) a short reel showing the same in motion, (c) a single static product or hand-made visual. Caption supports the visual — never replaces it.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    ...NO_GENERIC_STOCK,
    "No quote-card with white background and bold text. No 'aesthetic' lifestyle photo unrelated to the product.",
    "No hashtag block burned into the image.",
  ],
};

const telegram: CreativeDirection = {
  mediaRequired: false,
  mediaType: "screenshot",
  mediaPromptOrBrief:
    "Optional. A screenshot of the change, a changelog card, or a chart of operator-supplied numbers. Use media only when it adds signal — every post is a push.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "No promotional banners. No 'limited time' graphics.",
  ],
};

const devto: CreativeDirection = {
  mediaRequired: false,
  mediaType: "hero_image",
  mediaPromptOrBrief:
    "Article hero image optional. Recommended inline: real screenshots, system diagrams, and code blocks where they help the reader. Pick the hero from the article's strongest screenshot or diagram.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    ...NO_GENERIC_STOCK,
    "No generic developer-laptop hero images.",
  ],
};

const hashnode: CreativeDirection = {
  mediaRequired: false,
  mediaType: "diagram",
  mediaPromptOrBrief:
    "Architecture diagram, technical illustration, or an article cover that names the system in question. Hand-drawn or vector — but specific to this design rationale.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "No generic AI art. No abstract gradient covers.",
  ],
};

const youtube: CreativeDirection = {
  mediaRequired: true,
  mediaType: "thumbnail",
  mediaPromptOrBrief:
    "Thumbnail REQUIRED. Calm visual title — large readable text (3–5 words), one supporting element (screenshot, diagram, face), consistent style with the channel. No MrBeast-style hyperbole.",
  mediaRiskNotes: [
    "No clickbait expressions on the face / no exaggerated arrows.",
    "No ALL CAPS title plate.",
    "No fabricated 'before/after' shots.",
    "Operator must capture the actual video frame referenced — no placeholder.",
  ],
};

const indieHackers: CreativeDirection = {
  mediaRequired: false,
  mediaType: "screenshot",
  mediaPromptOrBrief:
    "Optional. A real screenshot or build-log visual that anchors the operator's claim — dashboards with operator-supplied numbers, a real product change, a stack diagram.",
  mediaRiskNotes: [
    ...DO_NOT_FABRICATE,
    "No fake MRR / traction / users charts.",
    "No polished launch graphics — IH readers see through them.",
  ],
};

// =====================================================================

export const PLATFORM_CREATIVE_DIRECTION: Record<FounderPlatform, CreativeDirection> = {
  reddit,
  x,
  bluesky,
  linkedin,
  threads,
  instagram,
  telegram,
  devto,
  hashnode,
  youtube,
  indie_hackers: indieHackers,
};

export function getCreativeDirection(
  platform: FounderPlatform,
): CreativeDirection {
  return PLATFORM_CREATIVE_DIRECTION[platform];
}
