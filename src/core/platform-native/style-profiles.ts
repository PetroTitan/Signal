/**
 * Per-platform style profiles.
 *
 * Pure data. Each profile names what makes a post FEEL native on
 * that platform — tone, density, pacing, structure, CTA style,
 * allowed and forbidden patterns, link/hashtag/emoji/media policy,
 * length guidance, and new-account safety notes.
 *
 * Existing platform shaping (the platformShape() switch in
 * src/core/generation/prompt-builder.ts) used to live as inline
 * strings inside one function. This file is the typed replacement
 * — it's read by the adapter, the prompt-builder, QA, and (later)
 * the UI preview surface.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { PlatformStyleProfile } from "./types";

// =====================================================================
// Reddit
// =====================================================================

const reddit: PlatformStyleProfile = {
  platform: "reddit",
  tone: "discussion-first community participant",
  density: "moderate",
  pacing: "conversational paragraphs, one idea per paragraph",
  structure:
    "honest opening (question, observation, postmortem), implementation detail, calm close that invites discussion only when warranted",
  ctaStyle:
    "soft invitation to share counter-examples or related experience — never 'thoughts?' or 'agree?' Optional CTA only when the post is genuinely seeking input.",
  allowedPatterns: [
    "implementation note",
    "postmortem framing",
    "specific technical observation",
    "affiliation disclosure when relevant",
  ],
  forbiddenPatterns: [
    "marketing voice",
    "engagement bait",
    "outbound link to own product on new accounts",
    "subreddit-name flattery",
  ],
  linkPolicy:
    "Avoid links on new accounts entirely. Established accounts: at most one outbound link, and only when load-bearing.",
  hashtagPolicy: "No hashtags. Reddit doesn't use them.",
  emojiPolicy: "Avoid. The occasional emoji is fine; decorative emoji is not.",
  mediaPolicy:
    "Text-first. Optional screenshot or diagram only if it adds proof. Never stock images.",
  maxLengthGuidance: "200–600 words typical. Markdown with one level of nesting at most.",
  newAccountSafetyNotes: [
    "Skip outbound links entirely.",
    "No subreddit-name flattery in the opening line.",
    "Disclose any affiliation in the first paragraph if the post touches your product.",
  ],
};

// =====================================================================
// X
// =====================================================================

const x: PlatformStyleProfile = {
  platform: "x",
  tone: "concise, sharp, idea-led builder",
  density: "high",
  pacing: "short sentences, one specific claim per post",
  structure:
    "first post is a standalone observation; thread parts each add one new specific datum",
  ctaStyle:
    "no explicit CTA on most posts. When a CTA is needed: a single concrete invitation, never 'agree?', never 'this is huge', never 'must read'.",
  allowedPatterns: [
    "single observation",
    "tight thread (3–7 parts) only when needed",
    "specific technical claim",
  ],
  forbiddenPatterns: [
    "hashtag spam",
    "engagement bait",
    "'thoughts?' / 'agree?' closer",
    "Reddit-style discussion framing",
    "long-form article shape",
    "'must read' / 'this is huge' / 'wild'",
  ],
  linkPolicy:
    "At most one outbound URL across the entire thread, placed in the part where the claim depends on it.",
  hashtagPolicy: "Zero hashtags. They read as bot/marketing on X.",
  emojiPolicy: "Avoid. One emoji per thread, max, and only when it serves the meaning.",
  mediaPolicy:
    "Optional diagram, screenshot, or short visual — should support the core idea, not decorate it.",
  maxLengthGuidance:
    "260 characters per post is the safe target. 3–7 thread parts is the calm range. 10+ feels desperate.",
  newAccountSafetyNotes: [
    "Single post only — no threads while warming.",
    "Zero outbound links for the first 30 days.",
    "Avoid quoting other accounts until the account has its own publishing history.",
  ],
};

// =====================================================================
// Bluesky
// =====================================================================

const bluesky: PlatformStyleProfile = {
  platform: "bluesky",
  tone: "calmer, internet-native, reflective",
  density: "moderate",
  pacing: "slower than X — full sentences, breath between ideas",
  structure:
    "single readable paragraph stating the observation; threading only when the idea genuinely needs the space",
  ctaStyle:
    "no explicit CTA in most cases. When relevant: a quiet question or pointer, not a call-to-share. Never X-style bait.",
  allowedPatterns: [
    "personal reflection",
    "internet-native phrasing",
    "lowercase opener",
    "calm observation",
  ],
  forbiddenPatterns: [
    "X-style bait",
    "'this blew up'",
    "hashtag spam",
    "rage-takes",
    "engagement framing",
  ],
  linkPolicy: "At most one link, at the end. No link previews when the post can stand without one.",
  hashtagPolicy: "Avoid. Bluesky culture treats hashtags as foreign.",
  emojiPolicy: "Sparse and meaningful only.",
  mediaPolicy: "Optional screenshot or diagram. Avoid engagement-bait visuals.",
  maxLengthGuidance:
    "Single post under 280 graphemes. Up to ~250 words as a single block when the post genuinely needs more — the splitter will thread it.",
  newAccountSafetyNotes: [
    "No threads on day 1 — single post until you've got 3 organic interactions.",
    "Zero outbound links for the first 14 days.",
  ],
};

// =====================================================================
// LinkedIn
// =====================================================================

const linkedin: PlatformStyleProfile = {
  platform: "linkedin",
  tone: "professional, operational, business-aware founder",
  density: "moderate",
  pacing:
    "short paragraphs (1–3 sentences) with vertical breathing room; lead with the observation, not the origin story",
  structure:
    "single observation or operational lesson — opening claim, two or three concrete reasons or examples, calm close",
  ctaStyle:
    "no 'thoughts?' / 'agree?' closers. No fake humility hooks. Optional CTA: a single concrete invitation tied to the post (e.g. 'we'd be glad to see how you're approaching this').",
  allowedPatterns: [
    "professional operational lesson",
    "concrete tradeoff",
    "company / founder update with real specifics",
  ],
  forbiddenPatterns: [
    "'I'm thrilled / honored / humbled' opener",
    "'agree?' / 'thoughts?' closer",
    "fake humility ('I'll never forget the moment...')",
    "inspiration bait",
    "'we are excited to announce' tone",
  ],
  linkPolicy: "At most one link, at the end. Never in the first sentence.",
  hashtagPolicy:
    "0–3 hashtags maximum and only if specifically meaningful. No generic #leadership #growth blocks.",
  emojiPolicy: "Almost never. One small emoji at most, and only if it carries meaning.",
  mediaPolicy:
    "Document carousel, clean diagram, or product screenshot. Professional and restrained — no stock smiles, no quote graphics.",
  maxLengthGuidance: "300–1200 words. Short paragraphs. Real specifics over advice.",
  newAccountSafetyNotes: [
    "No outbound links for the first 30 days.",
    "No carousel uploads while warming — single text post first.",
    "Skip the affiliation note in the first line; let the work speak.",
  ],
};

// =====================================================================
// Threads
// =====================================================================

const threads: PlatformStyleProfile = {
  platform: "threads",
  tone: "lightweight, conversational, human/operator angle",
  density: "sparse",
  pacing: "one short observation per post; less technical than X",
  structure: "single thought, optional follow-up reply for context",
  ctaStyle: "rare. When present: a quiet pointer, not a question to the audience.",
  allowedPatterns: [
    "lightweight observation",
    "operator scene-setting",
    "casual aside",
  ],
  forbiddenPatterns: [
    "'this blew up'",
    "'follow for daily'",
    "'comment below'",
    "'algorithm loves'",
    "hashtag spam",
  ],
  linkPolicy: "At most one URL. Threads doesn't reward links the way X does.",
  hashtagPolicy: "Avoid. A single specific hashtag if culturally relevant.",
  emojiPolicy: "Sparse. One emoji per post max.",
  mediaPolicy:
    "Optional simple image or behind-the-scenes screenshot. Lightweight — not a polished asset.",
  maxLengthGuidance: "200–400 characters typical. Plain text, sentences first.",
  newAccountSafetyNotes: [
    "Single post only — no threads while warming.",
    "Zero outbound links for the first 14 days.",
  ],
};

// =====================================================================
// Instagram
// =====================================================================

const instagram: PlatformStyleProfile = {
  platform: "instagram",
  tone: "visual-first; caption supports the image",
  density: "sparse",
  pacing: "short paragraphs (1–3 sentences); caption never tries to replace the visual",
  structure:
    "the visual carries the idea; the caption gives context, one sentence of substance, and a soft close",
  ctaStyle:
    "no 'link in bio' / 'DM me'. Optional soft pointer to product domain at the end. Mostly no CTA.",
  allowedPatterns: [
    "visual-first context",
    "short caption that supports the image",
    "calm operator framing",
  ],
  forbiddenPatterns: [
    "'link in bio'",
    "'double tap'",
    "'manifest'",
    "'7-figure'",
    "'DM me for'",
    "hustle / motivation spam",
    "huge hashtag blocks",
  ],
  linkPolicy: "No links in caption (they're not clickable). Pointer to domain at the end is fine.",
  hashtagPolicy: "1–4 specific hashtags at the end. No generic #fyp #viral #grindset blocks.",
  emojiPolicy: "Optional, sparse, never as decoration.",
  mediaPolicy:
    "Visual REQUIRED. Carousel, reel, or static. The post does not ship without it.",
  maxLengthGuidance: "200–1200 characters. Caption second; visual first.",
  newAccountSafetyNotes: [
    "First post should be a single static image, not a carousel or reel.",
    "Zero outbound URLs (Instagram strips them anyway).",
    "No hashtag block until the account has 5 posts of history.",
  ],
};

// =====================================================================
// Telegram
// =====================================================================

const telegram: PlatformStyleProfile = {
  platform: "telegram",
  tone: "direct, compact, update-oriented",
  density: "high",
  pacing: "tight sentences, no filler — channel posts are notifications",
  structure:
    "single short observation or changelog entry; one line of context, one line of detail, optional link",
  ctaStyle:
    "rare. A pointer to the changelog page or the related PR is fine — no audience-facing CTA.",
  allowedPatterns: [
    "changelog entry",
    "release note",
    "channel update with a single new fact",
  ],
  forbiddenPatterns: [
    "'join now'",
    "'limited spots'",
    "'exclusive leak'",
    "'DM me for'",
    "'private method'",
    "marketing newsletter cadence",
  ],
  linkPolicy:
    "At most one link, at the end — Telegram auto-renders the preview. Don't ship multiple links per post.",
  hashtagPolicy: "Zero hashtags.",
  emojiPolicy: "Sparse. One status emoji at most (✅ / 🚀 only when it carries meaning, not decoration).",
  mediaPolicy:
    "Optional screenshot or changelog card. Use media only when it adds signal — channel subscribers feel every push.",
  maxLengthGuidance: "200–1500 characters. Plain text. Linebreaks render.",
  newAccountSafetyNotes: [
    "Channel posts are pushes — no more than one per day until the channel has 10 subscribers.",
    "Zero promotional language.",
  ],
};

// =====================================================================
// dev.to
// =====================================================================

const devto: PlatformStyleProfile = {
  platform: "devto",
  tone: "technical, educational, markdown/article-friendly",
  density: "high",
  pacing: "article-shaped — short hook, then 2–4 useful sections with examples",
  structure:
    "hook (1–2 sentences) → 2–4 H2 sections with practical detail / code / tradeoffs → calm closing observation",
  ctaStyle:
    "soft product mention near the end ONLY if it's directly relevant. No CTA otherwise. Never 'subscribe to my newsletter'.",
  allowedPatterns: [
    "technical article",
    "implementation walkthrough",
    "code examples",
    "concrete tradeoff sections",
  ],
  forbiddenPatterns: [
    "status-post shape",
    "Reddit-style discussion framing",
    "'subscribe to my newsletter'",
    "thin tutorial without examples",
  ],
  linkPolicy:
    "Links allowed when they support a specific claim. Canonical URL field used when republishing.",
  hashtagPolicy: "1–4 lowercase tags at the end on a single `tags:` line.",
  emojiPolicy: "Avoid in headings. Sparse in body.",
  mediaPolicy:
    "Article hero image optional. Diagrams / screenshots / code blocks recommended where they help — never generic stock.",
  maxLengthGuidance: "600–1500 words. Markdown supported.",
  newAccountSafetyNotes: [
    "First two posts should be reference-quality (no product mention).",
    "No canonical-URL link to own product until the account has 3 posts.",
  ],
};

// =====================================================================
// Hashnode
// =====================================================================

const hashnode: PlatformStyleProfile = {
  platform: "hashnode",
  tone: "architecture / design rationale, engineering narrative",
  density: "high",
  pacing:
    "long-form essay shape — extended setup, several rationale sections, honest tradeoffs, concrete close",
  structure:
    "context → constraints → option space → choice and reasoning → tradeoffs accepted → outcome",
  ctaStyle:
    "no marketing CTA. Optional invitation to read related architecture docs only when load-bearing.",
  allowedPatterns: [
    "architecture deep-dive",
    "design decision narrative",
    "constraint-driven explanation",
    "tradeoff comparison",
  ],
  forbiddenPatterns: [
    "thin article (under 600 words is suspicious here)",
    "social-post shape",
    "Reddit-style discussion framing",
    "promotional close",
  ],
  linkPolicy: "Inline links supporting specific claims. No generic 'check out my other articles' block.",
  hashtagPolicy: "1–4 tags at the end on a single `tags:` line.",
  emojiPolicy: "Avoid.",
  mediaPolicy:
    "Architecture diagram, technical illustration, or article cover concept. No generic AI art.",
  maxLengthGuidance: "800–2500 words. Long-form expected.",
  newAccountSafetyNotes: [
    "First post should be the strongest piece of architecture writing the operator has — sets the tone of the publication.",
  ],
};

// =====================================================================
// YouTube
// =====================================================================

const youtube: PlatformStyleProfile = {
  platform: "youtube",
  tone: "educational, narrative, chapter-ready",
  density: "moderate",
  pacing: "title-first; description in 2–4 short paragraphs; chapters cover the video skeleton",
  structure:
    "title (45–75 chars) → hook line in description → 2–4 paragraphs → H2-style chapter labels → tags",
  ctaStyle:
    "no 'smash like' / 'don't forget to subscribe' / 'watch until the end'. Optional pointer to repo / docs in the description.",
  allowedPatterns: [
    "calm educational title",
    "honest setup in the description",
    "chapter labels that name what each section delivers",
  ],
  forbiddenPatterns: [
    "ALL CAPS title",
    "clickbait title",
    "MrBeast-style emphasis",
    "'smash like'",
    "'subscribe'",
    "'watch until the end'",
    "'algorithm-bait'",
  ],
  linkPolicy: "Links allowed in the description. Place the most important link first.",
  hashtagPolicy: "1–6 lowercase alphanumeric tags at the end on a single `tags:` line.",
  emojiPolicy: "Avoid in title. Sparse in description.",
  mediaPolicy:
    "Thumbnail concept REQUIRED. Title + description + chapters all derive from the same skeleton.",
  maxLengthGuidance: "Title 45–75 chars. Description 100–400 words.",
  newAccountSafetyNotes: [
    "First three videos should establish a recognisable thumbnail style — don't experiment yet.",
  ],
};

// =====================================================================
// Indie Hackers
// =====================================================================

const indieHackers: PlatformStyleProfile = {
  platform: "indie_hackers",
  tone: "transparent founder / operator",
  density: "moderate",
  pacing:
    "personal but specific — concrete numbers when the operator provides them, never invented metrics",
  structure:
    "context (where I was) → what I tried → what happened → tradeoff or lesson → optional next step",
  ctaStyle:
    "soft invitation to share similar experiences. Optional 'curious how others handle this' close — but only when the post genuinely seeks input.",
  allowedPatterns: [
    "build-in-public update",
    "honest lesson",
    "real number with context",
    "operator-to-operator framing",
  ],
  forbiddenPatterns: [
    "fake MRR",
    "exaggerated traction",
    "'we just hit X' without specifics",
    "marketing voice",
    "polished launch tone",
  ],
  linkPolicy: "One link at the end if you're pointing to a write-up — never multiple.",
  hashtagPolicy: "No hashtags.",
  emojiPolicy: "Sparse. One celebratory emoji is fine on a milestone post.",
  mediaPolicy:
    "Optional screenshot or build-log visual. Avoid fake traction charts — the community calls these out.",
  maxLengthGuidance: "300–900 words.",
  newAccountSafetyNotes: [
    "First post should be a calm context-setter, not a launch.",
    "No outbound links for the first 14 days.",
  ],
};

// =====================================================================
// Lookup
// =====================================================================

export const PLATFORM_STYLE_PROFILES: Record<FounderPlatform, PlatformStyleProfile> = {
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

export function getPlatformStyleProfile(
  platform: FounderPlatform,
): PlatformStyleProfile {
  return PLATFORM_STYLE_PROFILES[platform];
}
