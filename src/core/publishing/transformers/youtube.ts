/**
 * Phase F5.1 — YouTube manual distribution transformer.
 *
 * YouTube has NO documented intent URL for pre-filling upload
 * metadata. The founder uploads the video manually in YouTube
 * Studio; Signal's role is to prepare the text artifacts (title,
 * description, chapters, tags) so the founder can paste each field.
 *
 * This transformer is text-only. It does NOT:
 *   - upload video
 *   - generate thumbnails
 *   - call any YouTube API
 *   - run AI image generation
 *
 * It only shapes the canonical draft into YouTube-ready text.
 */

import type { CanonicalPost } from "../canonical-post";

const MAX_TITLE = 100;
const SOFT_TITLE_MIN = 45;
const SOFT_TITLE_MAX = 75;
const MAX_TAGS = 12;
const MAX_TAG_LEN = 30;

const TAG_SLUG_RE = /[a-z0-9-]/g;
const CHAPTER_HEADING_RE = /^(?:##?|###)\s+(.+)$/;

export interface YouTubeAssets {
  title: string;
  description: string;
  tags: string[];
  chapters: Array<{ timestamp: string; label: string }>;
  pinnedCommentSuggestion: string | null;
  thumbnailIdea: string | null;
  shortsHook: string | null;
  warnings: string[];
}

export function transformForYouTube(post: CanonicalPost): YouTubeAssets {
  const warnings: string[] = [];

  // ---- Title
  const titleRaw = (post.title ?? "").trim();
  const title = clampTitle(titleRaw);
  if (title.length === 0) {
    warnings.push("No title set — YouTube requires one before upload.");
  } else if (title.length < SOFT_TITLE_MIN) {
    warnings.push(
      `Title is ${title.length} chars. YouTube's algorithm prefers ${SOFT_TITLE_MIN}–${SOFT_TITLE_MAX}; consider expanding the hook.`,
    );
  } else if (title.length > SOFT_TITLE_MAX) {
    warnings.push(
      `Title is ${title.length} chars. Long titles get truncated in search results — consider tightening.`,
    );
  }

  // ---- Description
  const body = (post.bodyMarkdown ?? "").trim();
  const description = buildDescription(body, post);

  // ---- Chapters
  const chapters = extractChapters(body);

  // ---- Tags
  const tags = normalizeTags(post.tags);

  // ---- Pinned comment, thumbnail idea, shorts hook
  const pinnedCommentSuggestion = buildPinnedComment(post);
  const thumbnailIdea = buildThumbnailIdea(post);
  const shortsHook = buildShortsHook(post);

  return {
    title,
    description,
    tags,
    chapters,
    pinnedCommentSuggestion,
    thumbnailIdea,
    shortsHook,
    warnings,
  };
}

function clampTitle(t: string): string {
  return t.slice(0, MAX_TITLE);
}

/**
 * Strip markdown, preserve paragraph structure, append canonical URL
 * if present. YouTube's description box is plain text — markdown
 * renders as literal characters.
 */
function buildDescription(body: string, post: CanonicalPost): string {
  let text = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    // [text](url) → "text (url)"
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // Headings → plain text on their own line (drop the # prefix)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (post.canonicalUrl && !text.includes(post.canonicalUrl)) {
    text = `${text}\n\nMore: ${post.canonicalUrl}`;
  }

  return text;
}

/**
 * YouTube chapters require:
 *   - first chapter starts at 00:00
 *   - each chapter is at least 10s after the previous
 *   - exactly the format "MM:SS Label" or "HH:MM:SS Label" on its own line
 *
 * We can't know the real timestamps of a video Signal hasn't seen.
 * So this returns a CHAPTER OUTLINE — markdown H2/H3 headings in the
 * draft become a starter list with placeholder timestamps the
 * founder fills in. Returns an empty array when the draft has no
 * headings.
 */
function extractChapters(
  body: string,
): Array<{ timestamp: string; label: string }> {
  const out: Array<{ timestamp: string; label: string }> = [];
  let position = 0;
  for (const line of body.split("\n")) {
    const m = CHAPTER_HEADING_RE.exec(line);
    if (!m) continue;
    const label = m[1].trim().slice(0, 80);
    // Placeholder timestamps — operator edits in YouTube Studio.
    const minutes = position * 2;
    const ts = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    out.push({ timestamp: position === 0 ? "00:00" : ts, label });
    position += 1;
  }
  return out;
}

function normalizeTags(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const clean = String(raw)
      .toLowerCase()
      .match(TAG_SLUG_RE)
      ?.join("")
      .slice(0, MAX_TAG_LEN);
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function buildPinnedComment(post: CanonicalPost): string | null {
  if (!post.canonicalUrl && !post.summary) return null;
  const lines: string[] = [];
  if (post.summary) lines.push(post.summary.trim());
  if (post.canonicalUrl) {
    lines.push(`More context: ${post.canonicalUrl}`);
  }
  return lines.join("\n\n");
}

function buildThumbnailIdea(post: CanonicalPost): string | null {
  if (!post.title || post.title.trim().length === 0) return null;
  const hook = post.title.trim().slice(0, 60);
  return `Text overlay: "${hook}". Calm background; founder face optional; no MrBeast-style face / arrows / red circles.`;
}

function buildShortsHook(post: CanonicalPost): string | null {
  if (!post.bodyMarkdown) return null;
  const firstSentence = post.bodyMarkdown
    .trim()
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();
  if (!firstSentence) return null;
  return firstSentence.slice(0, 180);
}

/**
 * Open YouTube Studio directly. There is NO documented intent URL
 * that pre-fills upload metadata, so the founder uploads the video
 * manually and pastes each Signal-prepared field.
 */
export function buildYouTubeStudioUrl(): string {
  return "https://studio.youtube.com/";
}

/**
 * Plain-text dump of all the artifacts for the "Copy everything"
 * button, in the order the founder pastes them in Studio:
 *   - Title
 *   - Description (with chapters at the bottom)
 *   - Tags (comma-separated)
 */
export function buildFullYouTubeText(assets: YouTubeAssets): string {
  const chapterLines = assets.chapters
    .map((c) => `${c.timestamp} ${c.label}`)
    .join("\n");
  const descriptionWithChapters = chapterLines
    ? `${assets.description}\n\nChapters\n${chapterLines}`
    : assets.description;
  const blocks = [
    `Title:\n${assets.title}`,
    "",
    `Description:\n${descriptionWithChapters}`,
    "",
    `Tags: ${assets.tags.join(", ")}`,
  ];
  if (assets.thumbnailIdea) {
    blocks.push("", `Thumbnail idea: ${assets.thumbnailIdea}`);
  }
  if (assets.pinnedCommentSuggestion) {
    blocks.push("", `Pinned comment:\n${assets.pinnedCommentSuggestion}`);
  }
  if (assets.shortsHook) {
    blocks.push("", `Shorts hook: ${assets.shortsHook}`);
  }
  return blocks.join("\n").trimEnd();
}
