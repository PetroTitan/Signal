/**
 * Phase F4.5 — generation safety rules.
 *
 * Pure functions and constant lists used by the prompt builder and
 * the post-generation sanitizer. The goal is "every generated draft
 * is safe by default" — no fabricated metrics, no startup clichés,
 * no engagement bait, no false authority.
 *
 * These rules apply to BOTH:
 *   - the prompt sent to the AI provider (we tell it what to avoid)
 *   - the response we get back (we re-check before storing the draft)
 *
 * If a generated draft trips a hard rule, generate-draft.ts marks
 * the result `provider_refused` and falls back to the manual seed
 * path. The founder still gets a draft to start from; the unsafe
 * content never lands in weekly_plan_items.body.
 */

/** Phrases that should NEVER appear in a generated draft. */
export const BANNED_PHRASES: ReadonlyArray<string> = [
  "10x",
  "100x",
  "game changer",
  "game-changer",
  "game changing",
  "revolutionary",
  "we are excited",
  "we're excited",
  "we are thrilled",
  "the future of ai",
  "the future of work",
  "unlock the power",
  "next-gen",
  "next generation of",
  "smash like",
  "smash that like",
  "this changes everything",
  "nobody talks about this",
  "the ultimate",
  "the best ai tool",
  "the best ai",
  "the best founder tool",
  "the only tool you need",
  "you won't believe",
  "you wont believe",
  "mind-blowing",
  "mind blowing",
  "industry-leading",
  "industry leading",
  "first of its kind",
  "groundbreaking",
  "world's first",
  "world-class",
  "viral hack",
  "growth hack",
  "trust me",
  "as you can see",
  "in this article we will explore",
  "in this post we will explore",
  // F5.0 — X/LinkedIn-specific bait
  "viral thread",
  "must read",
  "must-read",
  "i'm thrilled",
  "im thrilled",
  "i am thrilled",
  "i'm honored",
  "im honored",
  "honored to announce",
  "humbled to announce",
  "agree?",
  "thoughts?",
  "let me know in the comments",
  "drop a 🔥",
  "drop a heart",
  "save this thread",
  "bookmark this",
  "follow for more",
  "like and follow",
  "tag a founder",
  "tag a friend",
  "rt if you agree",
  "retweet if",
  // F5.1 — YouTube spam patterns
  "watch until the end",
  "watch till the end",
  "watch to the end",
  "don't forget to subscribe",
  "dont forget to subscribe",
  "smash the like button",
  "smash that like",
  "smash like",
  "the algorithm",
  "algorithm loves",
  "hack the algorithm",
  "this video will change",
  "this video changed",
  "absolutely insane",
  "absolutely crazy",
  "secret strategy",
  "secret method",
  "dominate the",
  // F5.1 — Threads spam patterns
  "this blew up",
  "comment below",
  "follow for daily",
  // F5.1 — Instagram spam patterns
  "link in bio",
  "double tap",
  "manifest",
  "grindset",
  "7 figure",
  "7-figure",
  "passive income machine",
  "make money fast",
  "dm me for",
  "dm for",
  // F5.1 — Telegram spam patterns
  "join now",
  "limited spots",
  "exclusive leak",
  "private method",
];

/** Patterns that imply fabricated proof. */
export const FABRICATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\b\d+(?:,\d{3})*\s+(?:customers|users|signups|sign-ups|founders|subscribers)\b/i,
  /\b\$\d+(?:,\d{3})*\s*(?:MRR|ARR|revenue|in revenue|monthly recurring)\b/i,
  /\b\d+%\s+(?:faster|better|improvement|increase|growth|conversion)\b/i,
  /(?:partnered|partnership)\s+with\s+(?:google|stripe|openai|anthropic|amazon|microsoft|apple)/i,
  /\b(?:saas|founder)\s+(?:case study|testimonial)/i,
  /\b(?:trusted by|loved by|used by)\s+\d+(?:,\d{3})*\s+(?:companies|teams|founders|developers)\b/i,
  /\b(?:rated|ranked)\s+#?1\s+/i,
  /\bfeatured\s+(?:in|on)\s+(?:techcrunch|hacker news|product hunt)/i,
];

/**
 * Tone instructions handed to the AI provider.
 *
 * These are PLATFORM-NEUTRAL safety + honesty constraints. The
 * earlier version of this list ended with "End with a calm, founder-
 * shaped CTA — invitation to discuss, ..." — that single line was
 * biasing every platform's output toward Reddit-style discussion-
 * CTAs (LinkedIn 'thoughts?', X 'agree?', Bluesky engagement bait).
 * CTA shape now lives per-platform in
 * src/core/platform-native/style-profiles.ts (PlatformStyleProfile.
 * ctaStyle) and is injected by the platform-shape block. The global
 * tone instructions only cover universal safety + honesty.
 */
export const TONE_INSTRUCTIONS: ReadonlyArray<string> = [
  "Write as a real builder sharing operational lessons.",
  "Be calm, specific, technically honest.",
  "Prefer concrete tradeoffs and architecture details over hype.",
  "Acknowledge failures and constraints when they're relevant.",
  "Cite no metrics, customer counts, revenue, or testimonials unless the founder explicitly provided them.",
  'When unsure of a fact, write "Data not yet verified."',
  "No legal, medical, or financial claims without a source.",
  "No fake authority — never claim industry-wide leadership or superiority.",
  "No engagement bait — no rage takes, fake controversy, or manipulative hooks.",
  // CTA shape is platform-specific — see the per-platform CTA style
  // injected by the platform-shape block. Do not default to a
  // discussion-CTA closer; some platforms (X, Bluesky, Telegram,
  // Instagram) ship without an explicit CTA most of the time.
];

export interface SafetyVerdict {
  ok: boolean;
  violations: string[];
}

/**
 * Re-check a generated draft body before it lands in weekly_plan_items.
 * Pure function — no I/O. Returns the list of violations so callers
 * can decide whether to refuse or sanitize.
 */
export function evaluateDraftSafety(input: {
  title: string | null;
  body: string;
}): SafetyVerdict {
  const violations: string[] = [];
  const haystack = `${input.title ?? ""}\n${input.body}`.toLowerCase();

  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(phrase)) {
      violations.push(`Contains banned phrase: "${phrase}".`);
    }
  }
  for (const pattern of FABRICATION_PATTERNS) {
    const match = pattern.exec(`${input.title ?? ""}\n${input.body}`);
    if (match) {
      violations.push(
        `Looks fabricated: "${match[0].slice(0, 60)}". Add a source or remove the claim.`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Founder-readable description of the safety rules. Rendered in the
 * generation sheet so the operator knows what to expect, AND
 * appended to the system prompt so the provider sees the same rules.
 */
export function describeSafetyRules(): string {
  return [
    "Drafts must be honest, operational, and specific.",
    "No fabricated metrics, customer counts, revenue, partnerships, or testimonials.",
    "No startup clichés (10x, game-changer, revolutionary, mind-blowing).",
    "No engagement bait, fake controversy, or manipulative hooks.",
    "Calm CTA only — invitations, requests for feedback, build updates.",
    'If a claim can\'t be verified, the draft says "Data not yet verified."',
  ].join("\n");
}
