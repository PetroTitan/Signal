/**
 * Phase F5.1 — Instagram manual distribution transformer.
 *
 * Instagram is fundamentally a visual platform. Signal's role is to
 * shape the founder's draft into three artifacts the founder can
 * paste into the Instagram app:
 *
 *   - caption        (for image/carousel posts)
 *   - carousel_outline (5 slides of text the founder turns into images)
 *   - reel           (caption + hook for reel posts)
 *
 * The founder picks which artifact matches the post type they're
 * uploading. Signal does NOT touch the Instagram API, NEVER posts
 * automatically, and does NOT generate images.
 */

import type { CanonicalPost } from "../canonical-post";

const CAPTION_SOFT = 1200;
const CAPTION_HARD = 2200;
const MAX_HASHTAGS = 5;

const HASHTAG_BAN: ReadonlySet<string> = new Set([
  "fyp",
  "viral",
  "entrepreneurmindset",
  "millionairemindset",
  "grindset",
  "hustle",
  "hustleculture",
  "selfmade",
  "richmindset",
  "alphamindset",
]);

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export interface InstagramAssets {
  caption: string;
  carouselOutline: Array<{ slide: number; label: string; text: string }>;
  reel: {
    hook: string;
    caption: string;
  };
  hashtags: string[];
  warnings: string[];
}

export function transformForInstagram(post: CanonicalPost): InstagramAssets {
  const warnings: string[] = [];
  const body = (post.bodyMarkdown ?? "").trim();

  // ---- Caption: plain text, line breaks preserved, one URL max,
  // hashtag block stripped to clean tags.
  const captionPlain = renderMarkdownAsPlain(body);
  const captionSingleLink = keepOnlyFirstUrl(captionPlain).text;
  const captionStripped = stripInlineHashtags(captionSingleLink);
  let caption = captionStripped.trim();
  if (caption.length > CAPTION_HARD) {
    caption = caption.slice(0, CAPTION_HARD).trimEnd();
    warnings.push(
      `Caption was trimmed to Instagram's ${CAPTION_HARD}-character limit.`,
    );
  } else if (caption.length > CAPTION_SOFT) {
    warnings.push(
      `Caption is ${caption.length} chars. ${CAPTION_SOFT}-or-less reads better in feed.`,
    );
  }

  // ---- Carousel outline: 5 slides scaffolded from the draft.
  const carouselOutline = buildCarouselOutline(body, post);

  // ---- Reel: short hook + condensed caption.
  const reel = buildReelArtifacts(body, post);

  // ---- Hashtags: deduplicated, filtered, lowercased, max 5.
  const hashtags = filterHashtags(post.tags);

  if (hashtags.length === 0 && (post.tags ?? []).length > 0) {
    warnings.push(
      "All proposed hashtags were filtered (spam-bait list). Add fresh, specific ones if relevant.",
    );
  }

  return {
    caption,
    carouselOutline,
    reel,
    hashtags,
    warnings,
  };
}

function renderMarkdownAsPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function keepOnlyFirstUrl(text: string): { text: string; url: string | null } {
  let firstUrl: string | null = null;
  const out = text.replace(URL_RE, (match) => {
    if (firstUrl === null) {
      firstUrl = match;
      return match;
    }
    return "";
  });
  return { text: out.replace(/\s{2,}/g, " "), url: firstUrl };
}

function stripInlineHashtags(text: string): string {
  // Strip giant trailing hashtag blocks (5+ in a row).
  return text.replace(/(?:\s+#[A-Za-z0-9_]+){5,}\s*$/, "").trim();
}

function buildCarouselOutline(
  body: string,
  post: CanonicalPost,
): Array<{ slide: number; label: string; text: string }> {
  // Default 5-slide structure. Slot the founder's content where it fits.
  const title = post.title?.trim() ?? "";
  const summary = post.summary?.trim() ?? "";
  const firstParagraph = body.split(/\n\n+/)[0]?.trim() ?? "";
  const lastParagraph =
    body.split(/\n\n+/).slice(-1)[0]?.trim() ?? "";

  return [
    { slide: 1, label: "Hook", text: title || firstParagraph.slice(0, 140) },
    {
      slide: 2,
      label: "Problem",
      text:
        summary || firstParagraph.split(/(?<=[.!?])\s+/)[0]?.trim() || "",
    },
    {
      slide: 3,
      label: "Observation",
      text: firstParagraph.split(/(?<=[.!?])\s+/).slice(1).join(" ").trim(),
    },
    {
      slide: 4,
      label: "Insight",
      text: lastParagraph.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "",
    },
    {
      slide: 5,
      label: "CTA",
      text: post.canonicalUrl ? `More: ${post.canonicalUrl}` : "",
    },
  ].map((s) => ({ ...s, text: s.text.slice(0, 240) }));
}

function buildReelArtifacts(
  body: string,
  post: CanonicalPost,
): { hook: string; caption: string } {
  const firstSentence = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim()
    ?? "";
  const hook = (post.title?.trim() || firstSentence).slice(0, 120);

  const reelCaption = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .split(/\n\n+/)
    .slice(0, 2)
    .join("\n\n")
    .trim()
    .slice(0, 800);

  return { hook, caption: reelCaption };
}

function filterHashtags(input: string[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const slug = String(raw)
      .toLowerCase()
      .replace(/^#/, "")
      .match(/[a-z0-9_]/g)
      ?.join("");
    if (!slug) continue;
    if (HASHTAG_BAN.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/**
 * Open Instagram's web interface. Instagram has no documented
 * desktop-composer URL that pre-fills content; the founder posts
 * from the iOS / Android app or the new web composer.
 */
export function buildInstagramComposerUrl(): string {
  return "https://www.instagram.com/";
}

/**
 * Plain-text dump of all artifacts in a stable order for the
 * "Copy everything" button.
 */
export function buildFullInstagramText(assets: InstagramAssets): string {
  const blocks: string[] = [];
  blocks.push(`Caption:\n${assets.caption}`);
  if (assets.hashtags.length > 0) {
    blocks.push(
      "",
      `Hashtags: ${assets.hashtags.map((h) => `#${h}`).join(" ")}`,
    );
  }
  blocks.push("", "Carousel outline:");
  for (const slide of assets.carouselOutline) {
    blocks.push(`Slide ${slide.slide} — ${slide.label}: ${slide.text}`);
  }
  blocks.push("", `Reel hook: ${assets.reel.hook}`);
  blocks.push(`Reel caption:\n${assets.reel.caption}`);
  return blocks.join("\n").trimEnd();
}
