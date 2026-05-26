/**
 * Deterministic Bluesky-native copy adapter.
 *
 * Goal: take generic publishing text (markdown-cleaned but still
 * carrying blog/LinkedIn-style framing, corporate boilerplate, or
 * generic CTAs) and produce a tighter Bluesky-native version. NOT an
 * AI rewriter — every transformation is a closed-form rule with a
 * named, testable behavior.
 *
 * Design constraints
 * ------------------
 * - Pure: no I/O, no network, no LLM call. Same input → same output.
 * - High precision over recall: when in doubt, leave text alone.
 * - URL-safe: never touches a URL, hashtag, or @-mention.
 * - Factually safe: never invents or rewrites a claim. Only removes
 *   recognized boilerplate that adds no signal.
 * - Idempotent: running the adapter twice produces the same result
 *   as running it once.
 * - Reportable: each rule emits an operator-facing transformation
 *   note so the preview can show what changed.
 *
 * Pipeline order
 * --------------
 * Operates on plain text (post-markdown-strip). The shared payload
 * helper (`prepareBlueskyThreadPayload`) calls
 * `adaptCopyForBluesky` AFTER `stripMarkdownForSocial` and BEFORE
 * the splitter, so preview and publisher route the same adapted
 * text through the same splitter. Parity is preserved by
 * construction.
 *
 * Defensive guard
 * ---------------
 * A rule that would strip the body down to less than
 * MIN_BODY_AFTER_RULE characters is skipped. The original text is
 * always preferable to an empty publish.
 */

const MIN_BODY_AFTER_RULE = 20;

export interface BlueskyCopyAdapterInput {
  body: string;
}

export interface BlueskyCopyAdapterResult {
  body: string;
  transformationNotes: string[];
  /** Ids of rules that fired. Useful for tests + observability. */
  appliedRules: string[];
}

/**
 * Rule entry. A rule receives the in-flight body and returns either
 * `null` (no change) or `{ body, note }`. The pipeline composes
 * rules in declaration order; each rule sees the output of the
 * previous one.
 */
interface CopyAdapterRule {
  id: string;
  /** Operator-facing note when the rule fires. */
  note: string;
  /** Pure transform; returns null when the rule didn't match. */
  apply: (body: string) => string | null;
}

// =====================================================================
// Pipeline rules
// =====================================================================

const BLOG_INTRO_PATTERNS: RegExp[] = [
  // "In this post, I'll explain X. " → strip through end of sentence
  /^(?:In this (?:post|article|thread|piece),?\s*(?:I(?:'ll| am going to| will)?|we(?:'ll| are going to))?\s*[^.!?\n]+[.!?]\s+)/i,
  // "Today, I'm going to talk about X. "
  /^(?:Today,?\s+(?:I(?:'m| am)?|we(?:'re| are)?)\s+(?:going to|about to|gonna)\s+[^.!?\n]+[.!?]\s+)/i,
  // "Let me tell you about X. "
  /^(?:Let me (?:tell you|share|walk you through)\s+[^.!?\n]+[.!?]\s+)/i,
  // "Here's what I learned about X. " / "Here's why X. "
  /^(?:Here'?s (?:what|why|how) (?:I|we) (?:learned|discovered|figured out|realized)\s+[^.!?\n]+[.!?]\s+)/i,
];

const dropBlogIntro: CopyAdapterRule = {
  id: "drop_blog_intro",
  note: "Removed blog-style intro.",
  apply(body) {
    for (const pattern of BLOG_INTRO_PATTERNS) {
      const stripped = body.replace(pattern, "");
      if (
        stripped !== body &&
        stripped.trim().length >= MIN_BODY_AFTER_RULE
      ) {
        return stripped;
      }
    }
    return null;
  },
};

const CORPORATE_HYPE_PATTERNS: RegExp[] = [
  // "We are excited to announce that …" / "I'm thrilled to share: …"
  //
  // High-precision: only fires when an explicit `that` or `:` delimiter
  // separates the hype prefix from the announcement. Bare "We're
  // pleased to introduce Sarah" is left alone — without a delimiter we
  // can't tell where the hollow framing ends and the content begins.
  /^(?:We(?:'re| are)?|I(?:'m| am))\s+(?:excited|thrilled|pleased|delighted|proud|happy)\s+to\s+(?:announce|share|introduce|reveal|let you know)(?:\s+that\s+|\s*:\s*)/i,
];

const dropCorporateHype: CopyAdapterRule = {
  id: "drop_corporate_hype",
  note: "Removed corporate framing.",
  apply(body) {
    for (const pattern of CORPORATE_HYPE_PATTERNS) {
      const m = pattern.exec(body);
      if (!m) continue;
      const stripped = body.slice(m[0].length);
      // Capitalize the next char (the announcement now becomes the
      // opening word). Avoid mangling URL-starting tokens.
      const next =
        stripped.length > 0 && /[a-z]/.test(stripped[0])
          ? stripped[0].toUpperCase() + stripped.slice(1)
          : stripped;
      if (next.trim().length >= MIN_BODY_AFTER_RULE) {
        return next;
      }
    }
    return null;
  },
};

const SECTION_HEADING_WORDS = [
  "Summary",
  "Conclusion",
  "Introduction",
  "Background",
  "Overview",
  "TL;DR",
  "Key Takeaways",
  "Recap",
  "About",
  "Disclaimer",
];

const dropSectionHeadingStubs: CopyAdapterRule = {
  id: "drop_section_heading_stubs",
  note: "Removed section heading stubs.",
  apply(body) {
    const lines = body.split("\n");
    const kept: string[] = [];
    let changed = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const isStub = SECTION_HEADING_WORDS.some(
        (w) =>
          trimmed.toLowerCase() === w.toLowerCase() ||
          trimmed.toLowerCase() === `${w.toLowerCase()}:`,
      );
      if (isStub) {
        changed = true;
        continue;
      }
      kept.push(line);
    }
    if (!changed) return null;
    const result = kept.join("\n");
    return result.trim().length >= MIN_BODY_AFTER_RULE ? result : null;
  },
};

const dropBlockquoteMarkers: CopyAdapterRule = {
  id: "drop_blockquote_markers",
  note: "Stripped blockquote markers.",
  apply(body) {
    // "> quoted line" → "quoted line". Leaves content untouched
    // since Bluesky has no blockquote concept; the marker only
    // adds visual noise.
    const stripped = body.replace(/^[\t ]*>\s?/gm, "");
    if (stripped === body) return null;
    return stripped.trim().length >= MIN_BODY_AFTER_RULE ? stripped : null;
  },
};

const TRAILING_CTA_PATTERNS: RegExp[] = [
  // Trailing CTAs that follow the actual content. Each pattern is
  // anchored loosely: "...word boundary CTA <end>". We strip from
  // the start of the CTA phrase to end of body.
  /\s*Like and share[!.\s]*$/i,
  /\s*Follow (?:me )?for more[!.\s]*$/i,
  /\s*Subscribe to my newsletter[!.\s]*$/i,
  /\s*What do you think\??\s*Comment below[!.\s]*$/i,
  /\s*Let me know in the comments[!.\s]*$/i,
  /\s*Share this post if (?:you|it)[^.!?\n]*[!.\s]*$/i,
];

const dropTrailingCta: CopyAdapterRule = {
  id: "drop_trailing_cta",
  note: "Removed trailing CTA.",
  apply(body) {
    let next = body;
    let fired = false;
    for (const pattern of TRAILING_CTA_PATTERNS) {
      const candidate = next.replace(pattern, "");
      if (
        candidate !== next &&
        candidate.trim().length >= MIN_BODY_AFTER_RULE
      ) {
        next = candidate;
        fired = true;
      }
    }
    return fired ? next : null;
  },
};

const ORIGINALLY_PUBLISHED_PATTERNS: RegExp[] = [
  /Originally published (?:at|on)\s+\S+\.?/i,
  /(?:Continue|Read the full (?:article|post)) (?:at|on)\s+\S+\.?/i,
  /Cross-posted (?:from|on)\s+\S+\.?/i,
];

const dropOriginallyPublished: CopyAdapterRule = {
  id: "drop_originally_published",
  note: "Removed 'originally published' reference.",
  apply(body) {
    let next = body;
    let fired = false;
    for (const pattern of ORIGINALLY_PUBLISHED_PATTERNS) {
      const candidate = next.replace(pattern, "");
      if (
        candidate !== next &&
        candidate.trim().length >= MIN_BODY_AFTER_RULE
      ) {
        next = candidate;
        fired = true;
      }
    }
    return fired ? next : null;
  },
};

const collapseBlankLines: CopyAdapterRule = {
  id: "collapse_blank_lines",
  note: "Collapsed extra blank lines.",
  apply(body) {
    const stripped = body.replace(/\n{3,}/g, "\n\n");
    if (stripped === body) return null;
    return stripped;
  },
};

const trimTrailingWhitespace: CopyAdapterRule = {
  id: "trim_trailing_whitespace",
  note: "Trimmed trailing whitespace.",
  apply(body) {
    // Drop spaces/tabs at end of each line; trim the whole body.
    const stripped = body.replace(/[\t ]+(?=\n)/g, "").trim();
    if (stripped === body) return null;
    return stripped;
  },
};

/**
 * Pipeline order matters. Boilerplate that appears at the START of
 * the body is removed first, then trailing CTAs, then mid-text
 * markers, then whitespace cleanup last.
 */
const PIPELINE: CopyAdapterRule[] = [
  dropBlogIntro,
  dropCorporateHype,
  dropSectionHeadingStubs,
  dropBlockquoteMarkers,
  dropTrailingCta,
  dropOriginallyPublished,
  collapseBlankLines,
  trimTrailingWhitespace,
];

// =====================================================================
// Entry point
// =====================================================================

export function adaptCopyForBluesky(
  input: BlueskyCopyAdapterInput,
): BlueskyCopyAdapterResult {
  let body = input.body;
  const transformationNotes: string[] = [];
  const appliedRules: string[] = [];
  for (const rule of PIPELINE) {
    const next = rule.apply(body);
    if (next === null) continue;
    body = next;
    appliedRules.push(rule.id);
    if (!transformationNotes.includes(rule.note)) {
      transformationNotes.push(rule.note);
    }
  }
  return { body, transformationNotes, appliedRules };
}

/**
 * Pure helper exported for tests + sibling modules. Not for general
 * consumption — callers should use `adaptCopyForBluesky` which runs
 * the full pipeline.
 */
export const __pipelineRules = PIPELINE.map((r) => r.id);
