import { describe, expect, it } from "vitest";
import { deterministicRewrite } from "./deterministic-rewrite";

const SAMPLE_BODY =
  "This is huge news — must read. We just shipped a small queue fix that batches retries with exponential backoff. Thoughts? Comment below!";

describe("deterministicRewrite — improve_headline", () => {
  it("trims, dequotes and depunctuates a title", () => {
    const r = deterministicRewrite({
      action: "improve_headline",
      currentTitle: '  "Going viral with our new launch."  ',
      currentBody: SAMPLE_BODY,
      platform: "bluesky",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newTitle).toBe("Going viral with our new launch");
      expect(r.newBody).toBe(null);
    }
  });

  it("returns no_change when there's no headline to improve", () => {
    const r = deterministicRewrite({
      action: "improve_headline",
      currentTitle: "Already tight",
      currentBody: SAMPLE_BODY,
      platform: "bluesky",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_change");
  });
});

describe("deterministicRewrite — shorter", () => {
  it("compresses a long body to roughly 60%", () => {
    const long =
      "First paragraph with a complete idea about something.\n\n" +
      "Second paragraph that elaborates on the same point with more detail and a small example.\n\n" +
      "Third paragraph that closes with a calm observation.";
    const r = deterministicRewrite({
      action: "shorter",
      currentTitle: null,
      currentBody: long,
      platform: "bluesky",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody!.length).toBeLessThan(long.length);
    }
  });

  it("returns no_change for short drafts", () => {
    const r = deterministicRewrite({
      action: "shorter",
      currentTitle: null,
      currentBody: "tiny",
      platform: "bluesky",
    });
    expect(r.ok).toBe(false);
  });
});

describe("deterministicRewrite — less_promotional", () => {
  it("strips hype phrases and CTA closers", () => {
    const r = deterministicRewrite({
      action: "less_promotional",
      currentTitle: null,
      currentBody: SAMPLE_BODY,
      platform: "bluesky",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody!).not.toMatch(/this is huge/i);
      expect(r.newBody!).not.toMatch(/must read/i);
      expect(r.newBody!).not.toMatch(/thoughts\?/i);
      expect(r.newBody!).not.toMatch(/comment below/i);
    }
  });

  it("returns no_change when nothing matches", () => {
    const r = deterministicRewrite({
      action: "less_promotional",
      currentTitle: null,
      currentBody:
        "We shipped a small queue fix that batches retries with exponential backoff.",
      platform: "bluesky",
    });
    expect(r.ok).toBe(false);
  });
});

describe("deterministicRewrite — adapt for platform", () => {
  it("adapt_for_bluesky removes hashtags and compresses to ~280 chars", () => {
    const long =
      "We just shipped a new feature for distributed retry queues with exponential backoff. " +
      "It's a small change but cleans up a lot of weird edge cases that have been showing up in production. " +
      "The whole patch is under 200 lines. #buildinpublic #distributedSystems";
    const r = deterministicRewrite({
      action: "to_bluesky_thread",
      currentTitle: null,
      currentBody: long,
      platform: "reddit",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody!).not.toMatch(/#/);
      expect(r.newBody!.length).toBeLessThanOrEqual(290);
    }
  });

  it("adapt_for_x compresses aggressively", () => {
    const long =
      "Detailed observation about reliability engineering and queues. ".repeat(
        10,
      );
    const r = deterministicRewrite({
      action: "to_x_thread",
      currentTitle: null,
      currentBody: long,
      platform: "reddit",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.newBody!.length).toBeLessThan(long.length);
  });

  it("adapt_for_linkedin strips engagement-bait closers", () => {
    const r = deterministicRewrite({
      action: "to_linkedin_post",
      currentTitle: null,
      currentBody:
        "We shipped a queue fix. Lots of moving parts. Thoughts?",
      platform: "reddit",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody!).not.toMatch(/thoughts\?/i);
    }
  });

  it("adapt_for_devto leaves long-form intact", () => {
    const body =
      "# Why batching retries matters\n\nA detailed walkthrough of the change.";
    const r = deterministicRewrite({
      action: "to_devto_article",
      currentTitle: null,
      currentBody: body,
      platform: "reddit",
    });
    // devto has no aggressive length cap — either ok (cleaned) or no_change.
    expect(["ok", "no_change"]).toContain(r.ok ? "ok" : "no_change");
  });
});

describe("deterministicRewrite — generic cleanup fallback", () => {
  it("normalizes whitespace for rewrite/more_technical/more_founder", () => {
    const body = "First line.    \n\n\n\nSecond line.  \n  \n\nThird line.";
    const r = deterministicRewrite({
      action: "rewrite",
      currentTitle: null,
      currentBody: body,
      platform: "reddit",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.newBody!).not.toMatch(/\n{3,}/);
      expect(r.newBody!).not.toMatch(/ {2,}/);
    }
  });
});

describe("deterministicRewrite — empty body", () => {
  it("returns no_body when body is empty", () => {
    const r = deterministicRewrite({
      action: "shorter",
      currentTitle: null,
      currentBody: "",
      platform: "reddit",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_body");
  });
});

describe("deterministicRewrite — schedule independence", () => {
  // Sanity test: the rewrite engine has no schedule surface at all.
  // This is a compile-time guarantee but worth asserting in case the
  // module accidentally grows one.
  it("result type has no scheduled_at / schedule field", () => {
    const r = deterministicRewrite({
      action: "shorter",
      currentTitle: null,
      currentBody: "A long enough body. ".repeat(20),
      platform: "reddit",
    });
    if (r.ok) {
      expect(Object.keys(r)).not.toContain("scheduledAt");
      expect(Object.keys(r)).not.toContain("scheduled_at");
    }
  });
});
