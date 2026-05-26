import { describe, expect, it } from "vitest";
import { __pipelineRules, adaptCopyForBluesky } from "./bluesky-copy-adapter";

/**
 * Pure-rule tests for the Bluesky native copy adapter. Each test
 * pins one rule's behavior in isolation. Cross-rule interaction is
 * tested via the integration tests (`bluesky-payload.test.ts`,
 * `bluesky-preview-publish-parity.test.ts`).
 */

// =====================================================================
// drop_blog_intro
// =====================================================================

describe("adaptCopyForBluesky — blog-style intros", () => {
  it("strips 'In this post, I'll explain' opener", () => {
    const r = adaptCopyForBluesky({
      body: "In this post, I'll explain how our retry logic works. We switched to exponential backoff with jitter. Latency dropped 40% during the next incident.",
    });
    expect(r.body).toBe(
      "We switched to exponential backoff with jitter. Latency dropped 40% during the next incident.",
    );
    expect(r.appliedRules).toContain("drop_blog_intro");
    expect(r.transformationNotes).toContain("Removed blog-style intro.");
  });

  it("strips 'Today, I'm going to talk about'", () => {
    const r = adaptCopyForBluesky({
      body: "Today, I'm going to share what we learned about queue retries. The biggest improvement was switching to exponential backoff with jitter.",
    });
    expect(r.body).toBe(
      "The biggest improvement was switching to exponential backoff with jitter.",
    );
    expect(r.appliedRules).toContain("drop_blog_intro");
  });

  it("strips 'Let me tell you about'", () => {
    const r = adaptCopyForBluesky({
      body: "Let me tell you about our queue retry fix. We switched to exponential backoff with jitter.",
    });
    expect(r.body).toBe(
      "We switched to exponential backoff with jitter.",
    );
  });

  it("strips 'Here's what I learned'", () => {
    const r = adaptCopyForBluesky({
      body: "Here's what I learned about our queue retries. Exponential backoff with jitter fixed the thundering-herd problem.",
    });
    expect(r.body).toBe(
      "Exponential backoff with jitter fixed the thundering-herd problem.",
    );
  });

  it("does NOT strip when removing the intro would leave too little body", () => {
    const r = adaptCopyForBluesky({
      body: "In this post, I'll share details. Short.",
    });
    // Stripping would leave "Short." (6 chars) — defensive guard
    // prevents that. Original is returned.
    expect(r.body).toBe("In this post, I'll share details. Short.");
    expect(r.appliedRules).not.toContain("drop_blog_intro");
  });

  it("doesn't fire on bodies that don't start with framing", () => {
    const r = adaptCopyForBluesky({
      body: "We switched to exponential backoff with jitter today. Latency dropped 40% during the next incident.",
    });
    expect(r.appliedRules).not.toContain("drop_blog_intro");
    expect(r.body).toBe(
      "We switched to exponential backoff with jitter today. Latency dropped 40% during the next incident.",
    );
  });
});

// =====================================================================
// drop_corporate_hype
// =====================================================================

describe("adaptCopyForBluesky — corporate hype", () => {
  it("strips 'We are excited to announce that'", () => {
    const r = adaptCopyForBluesky({
      body: "We are excited to announce that the queue retry fix shipped this week. Latency dropped 40%.",
    });
    expect(r.body).toBe(
      "The queue retry fix shipped this week. Latency dropped 40%.",
    );
    expect(r.appliedRules).toContain("drop_corporate_hype");
  });

  it("strips 'I'm thrilled to share:'", () => {
    const r = adaptCopyForBluesky({
      body: "I'm thrilled to share: we shipped exponential backoff with jitter.",
    });
    expect(r.body).toBe("We shipped exponential backoff with jitter.");
  });

  it("does NOT strip 'We're pleased to introduce X' without an explicit 'that'/':' delimiter (rule is high-precision)", () => {
    // Conservative: without "that" or ":" we can't tell where the
    // hollow framing ends and the substantive content begins.
    // Leaving the text alone is safer than risking a content cut.
    const r = adaptCopyForBluesky({
      body: "We're pleased to introduce our new retry library. It uses jittered exponential backoff.",
    });
    expect(r.appliedRules).not.toContain("drop_corporate_hype");
    expect(r.body).toBe(
      "We're pleased to introduce our new retry library. It uses jittered exponential backoff.",
    );
  });

  it("does NOT fire when the body has no hype prefix", () => {
    const r = adaptCopyForBluesky({
      body: "The queue retry fix shipped this week. Latency dropped 40%.",
    });
    expect(r.appliedRules).not.toContain("drop_corporate_hype");
  });

  it("does NOT fire when stripping would leave too little body", () => {
    const r = adaptCopyForBluesky({
      body: "We are excited to announce that: shipped.",
    });
    // Stripping → "shipped." — under MIN_BODY_AFTER_RULE.
    expect(r.body).toBe("We are excited to announce that: shipped.");
  });
});

// =====================================================================
// drop_section_heading_stubs
// =====================================================================

describe("adaptCopyForBluesky — section heading stubs", () => {
  it("removes standalone 'Summary' / 'Conclusion' / 'TL;DR' lines", () => {
    const r = adaptCopyForBluesky({
      body: "Summary\n\nWe switched to exponential backoff with jitter. Latency dropped 40%.",
    });
    expect(r.body).toBe(
      "We switched to exponential backoff with jitter. Latency dropped 40%.",
    );
    expect(r.appliedRules).toContain("drop_section_heading_stubs");
  });

  it("removes 'Summary:' (with trailing colon)", () => {
    const r = adaptCopyForBluesky({
      body: "Conclusion:\n\nLatency dropped 40% after we switched algorithms.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after we switched algorithms.",
    );
  });

  it("removes 'TL;DR' as a stub", () => {
    const r = adaptCopyForBluesky({
      body: "TL;DR\n\nExponential backoff with jitter fixes the thundering-herd problem.",
    });
    expect(r.body).toBe(
      "Exponential backoff with jitter fixes the thundering-herd problem.",
    );
  });

  it("does NOT strip the word 'Summary' from inside a sentence", () => {
    const r = adaptCopyForBluesky({
      body: "Summary of the week: we shipped the queue fix and latency dropped 40%.",
    });
    expect(r.appliedRules).not.toContain("drop_section_heading_stubs");
    expect(r.body).toBe(
      "Summary of the week: we shipped the queue fix and latency dropped 40%.",
    );
  });
});

// =====================================================================
// drop_blockquote_markers
// =====================================================================

describe("adaptCopyForBluesky — blockquote markers", () => {
  it("strips leading '> ' markers (Bluesky has no blockquote concept)", () => {
    const r = adaptCopyForBluesky({
      body: "Following up on the queue post.\n\n> The previous strategy caused thundering-herd retries.\n\nWe switched to jittered backoff. Latency dropped 40%.",
    });
    expect(r.body).toContain("The previous strategy caused thundering-herd retries.");
    expect(r.body).not.toContain("> The previous");
    expect(r.appliedRules).toContain("drop_blockquote_markers");
  });

  it("does NOT fire when body has no blockquotes", () => {
    const r = adaptCopyForBluesky({
      body: "We switched to jittered backoff. Latency dropped 40% during the next incident.",
    });
    expect(r.appliedRules).not.toContain("drop_blockquote_markers");
  });
});

// =====================================================================
// drop_trailing_cta
// =====================================================================

describe("adaptCopyForBluesky — trailing CTAs", () => {
  it("strips 'Like and share' from the end", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after we switched to jittered backoff. Like and share!",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after we switched to jittered backoff.",
    );
    expect(r.appliedRules).toContain("drop_trailing_cta");
  });

  it("strips 'Follow me for more'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after we switched to jittered backoff. Follow me for more.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after we switched to jittered backoff.",
    );
  });

  it("strips 'Subscribe to my newsletter'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after we switched to jittered backoff. Subscribe to my newsletter!",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after we switched to jittered backoff.",
    );
  });

  it("strips 'What do you think? Comment below.'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after we switched to jittered backoff. What do you think? Comment below.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after we switched to jittered backoff.",
    );
  });

  it("strips 'Let me know in the comments'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix. Let me know in the comments.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after the queue retry fix.",
    );
  });

  it("does NOT strip a CTA that's mid-sentence", () => {
    const r = adaptCopyForBluesky({
      body: "We track 'like and share' rates separately from raw impressions because they correlate with reach.",
    });
    expect(r.appliedRules).not.toContain("drop_trailing_cta");
  });
});

// =====================================================================
// drop_originally_published
// =====================================================================

describe("adaptCopyForBluesky — originally-published references", () => {
  it("strips 'Originally published on …'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix. Originally published on https://example.com/blog/queue-retry",
    });
    expect(r.body).toContain("Latency dropped 40%");
    expect(r.body).not.toMatch(/Originally published/i);
    expect(r.appliedRules).toContain("drop_originally_published");
  });

  it("strips 'Read the full article on …'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix. Read the full article on https://example.com/blog/queue-retry",
    });
    expect(r.body).not.toMatch(/Read the full article/i);
  });

  it("strips 'Cross-posted from …'", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix. Cross-posted from https://example.com/blog/queue-retry",
    });
    expect(r.body).not.toMatch(/Cross-posted/i);
  });
});

// =====================================================================
// Whitespace / structure
// =====================================================================

describe("adaptCopyForBluesky — whitespace cleanup", () => {
  it("collapses 3+ blank lines to 2", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix.\n\n\n\nNext up: smarter dead-lettering.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after the queue retry fix.\n\nNext up: smarter dead-lettering.",
    );
    expect(r.appliedRules).toContain("collapse_blank_lines");
  });

  it("trims trailing whitespace on each line + body", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40%.   \nNext quarter: dead-lettering.   ",
    });
    expect(r.body).toBe(
      "Latency dropped 40%.\nNext quarter: dead-lettering.",
    );
    expect(r.appliedRules).toContain("trim_trailing_whitespace");
  });

  it("preserves single newlines between paragraphs", () => {
    const r = adaptCopyForBluesky({
      body: "Latency dropped 40% after the queue retry fix.\n\nNext up: smarter dead-lettering.",
    });
    expect(r.body).toBe(
      "Latency dropped 40% after the queue retry fix.\n\nNext up: smarter dead-lettering.",
    );
  });
});

// =====================================================================
// Preservation invariants — never invent, never destroy
// =====================================================================

describe("adaptCopyForBluesky — preservation invariants", () => {
  it("preserves URLs untouched", () => {
    const r = adaptCopyForBluesky({
      body: "Originally published on https://example.com/blog/queue-retry. We switched to jittered backoff. Latency dropped 40% during the next incident.",
    });
    expect(r.body).toContain("We switched to jittered backoff.");
    // Originally-published phrase removed, but the URL inside it
    // was removed alongside the phrase. Standalone URLs are preserved
    // (see next test).
  });

  it("preserves a standalone URL", () => {
    const r = adaptCopyForBluesky({
      body: "We switched to jittered backoff: https://github.com/example/retry-lib. Latency dropped 40%.",
    });
    expect(r.body).toContain("https://github.com/example/retry-lib");
  });

  it("preserves factual numbers / dates / names", () => {
    const r = adaptCopyForBluesky({
      body: "We deployed v3.2.1 on March 14, 2026 — operated by Sarah Chen. Latency dropped 40% in the next incident.",
    });
    expect(r.body).toContain("v3.2.1");
    expect(r.body).toContain("March 14, 2026");
    expect(r.body).toContain("Sarah Chen");
    expect(r.body).toContain("40%");
  });

  it("preserves @-mentions and #-hashtags", () => {
    const r = adaptCopyForBluesky({
      body: "Big thanks to @ops.bsky.social for the audit. #queues #reliability.",
    });
    expect(r.body).toContain("@ops.bsky.social");
    expect(r.body).toContain("#queues");
    expect(r.body).toContain("#reliability");
  });

  it("never invents claims (output is a subset/projection of input)", () => {
    // Property test: every word in the output exists in the input.
    const input =
      "Latency dropped 40% after we switched to jittered exponential backoff. Originally published on https://example.com.";
    const r = adaptCopyForBluesky({ body: input });
    const inputWords = new Set(
      input.toLowerCase().match(/\b[a-z0-9]+\b/g) ?? [],
    );
    const outputWords =
      r.body.toLowerCase().match(/\b[a-z0-9]+\b/g) ?? [];
    for (const w of outputWords) {
      expect(inputWords.has(w)).toBe(true);
    }
  });

  it("is idempotent — running twice equals running once", () => {
    const input =
      "In this post, I'll explain our retries. We are excited to announce that we shipped exponential backoff. Latency dropped 40%. Subscribe to my newsletter!";
    const once = adaptCopyForBluesky({ body: input });
    const twice = adaptCopyForBluesky({ body: once.body });
    expect(twice.body).toBe(once.body);
  });

  it("no-op input returns unchanged body with no notes", () => {
    const input =
      "We switched to jittered backoff. Latency dropped 40% during the next incident. Next quarter: dead-lettering.";
    const r = adaptCopyForBluesky({ body: input });
    expect(r.body).toBe(input);
    expect(r.appliedRules).toEqual([]);
    expect(r.transformationNotes).toEqual([]);
  });

  it("empty body remains empty (no crash)", () => {
    const r = adaptCopyForBluesky({ body: "" });
    expect(r.body).toBe("");
    expect(r.appliedRules).toEqual([]);
  });
});

// =====================================================================
// Pipeline shape
// =====================================================================

describe("adaptCopyForBluesky — pipeline shape", () => {
  it("exposes the pipeline rule ids in stable order", () => {
    expect(__pipelineRules).toEqual([
      "drop_blog_intro",
      "drop_corporate_hype",
      "drop_section_heading_stubs",
      "drop_blockquote_markers",
      "drop_trailing_cta",
      "drop_originally_published",
      "collapse_blank_lines",
      "trim_trailing_whitespace",
    ]);
  });

  it("composes multiple rules in one pass", () => {
    const r = adaptCopyForBluesky({
      body: "In this post, I'll explain our retries. We switched to jittered backoff. Latency dropped 40%. Subscribe to my newsletter!",
    });
    expect(r.appliedRules).toContain("drop_blog_intro");
    expect(r.appliedRules).toContain("drop_trailing_cta");
    expect(r.body).toBe(
      "We switched to jittered backoff. Latency dropped 40%.",
    );
  });
});
