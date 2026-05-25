import { describe, expect, it } from "vitest";
import { renderXPreview } from "./x-preview";
import type { PreviewInput } from "./preview-types";

function makeInput(overrides: Partial<PreviewInput> = {}): PreviewInput {
  return {
    platform: "x",
    title: null,
    body: "",
    identity: {
      displayName: "Op",
      handle: "op",
      avatarUrl: null,
    },
    creative: null,
    ...overrides,
  };
}

describe("renderXPreview — single tweet", () => {
  it("renders a short post as a single tweet", () => {
    const r = renderXPreview(makeInput({ body: "We shipped a queue fix." }));
    expect(r.parts).toHaveLength(1);
    expect(r.format).toBe("single_post");
    expect(r.perPartBudget).toBe(280);
    expect(r.unit).toBe("chars");
  });

  it("treats URLs as 23-char tokens for budget", () => {
    const url = "https://signal.example.com/posts/2026-05-20-queues";
    const body = `Read the writeup: ${url}`;
    const r = renderXPreview(makeInput({ body }));
    // Original visible length is much greater than 23+18 — but URL
    // shortening should keep it well under budget.
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0].length).toBeLessThan(280);
    expect(r.parts[0].text).toContain(url);
  });
});

describe("renderXPreview — thread", () => {
  it("splits over 280 chars into a thread", () => {
    const body =
      "Reliability engineering rant time. " +
      "Last quarter we ran into a thundering-herd retry storm that took the API offline for nine minutes. " +
      "The fix was tiny: exponential backoff with jitter. " +
      "But the actual story is the postmortem. " +
      "We discovered the previous on-call doc was 18 months stale. " +
      "It pointed at services that no longer exist. " +
      "The single biggest reliability investment we made this year was deleting old runbooks.";
    const r = renderXPreview(makeInput({ body }));
    expect(r.parts.length).toBeGreaterThan(1);
    expect(r.format).toBe("thread");
    for (const p of r.parts) {
      expect(p.length).toBeLessThanOrEqual(280);
    }
  });

  it("preserves URLs verbatim in thread parts", () => {
    const url = "https://signal.example.com/queue-retry";
    const body =
      "Long thread incoming. " +
      "First fix: backoff. " +
      "Second fix: deletion. " +
      `Third fix: ${url}. ` +
      "Sentence five. Sentence six. Sentence seven. Sentence eight. Sentence nine. Sentence ten. Sentence eleven. Sentence twelve. Sentence thirteen. Sentence fourteen. Sentence fifteen. ".repeat(
        3,
      );
    const r = renderXPreview(makeInput({ body }));
    const reassembled = r.parts.map((p) => p.text).join(" ");
    expect(reassembled).toContain(url);
  });
});

describe("renderXPreview — warnings", () => {
  it("warns on engagement bait closers", () => {
    const r = renderXPreview(
      makeInput({ body: "We shipped a queue fix. Thoughts?" }),
    );
    expect(r.warnings.some((w) => w.kind === "too_promotional")).toBe(true);
  });

  it("warns on high hashtag density", () => {
    const r = renderXPreview(
      makeInput({ body: "ship #a #b #c #d #e #f #g" }),
    );
    expect(r.warnings.some((w) => w.kind === "high_hashtag_density")).toBe(
      true,
    );
  });

  it("warns when a title is supplied (X ignores it)", () => {
    const r = renderXPreview(
      makeInput({ title: "Headline", body: "post body" }),
    );
    expect(
      r.warnings.some((w) => w.kind === "title_ignored_by_platform"),
    ).toBe(true);
  });

  it("warns when alt text is missing on attached image", () => {
    const r = renderXPreview(
      makeInput({
        body: "ship",
        creative: {
          assetUrl: "https://x/y.png",
          altText: "",
          sourceType: "uploaded",
        },
      }),
    );
    expect(r.warnings.some((w) => w.kind === "alt_text_missing")).toBe(true);
  });
});

describe("renderXPreview — never fakes metrics", () => {
  it("result has no engagement / verification / timestamp fields", () => {
    const r = renderXPreview(makeInput({ body: "hi" }));
    expect(r).not.toHaveProperty("likes");
    expect(r).not.toHaveProperty("retweets");
    expect(r).not.toHaveProperty("verified");
    expect(r).not.toHaveProperty("timestamp");
  });
});

describe("renderXPreview — determinism", () => {
  it("two identical inputs produce identical outputs", () => {
    const input = makeInput({ body: "Hello https://signal.example.com" });
    expect(renderXPreview(input)).toEqual(renderXPreview(input));
  });
});
