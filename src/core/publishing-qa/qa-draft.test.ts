import { describe, expect, it } from "vitest";
import { qaDraft } from "./qa-draft";
import type { QaDraft, QaIdentity, QaInput, QaRecentPost } from "./types";

function identity(overrides: Partial<QaIdentity> = {}): QaIdentity {
  return {
    platform: "x",
    ageDays: 200,
    displayName: "WebmasterID — X",
    handle: "@Webmasteridcore",
    status: "active",
    ...overrides,
  };
}

function draft(overrides: Partial<QaDraft> = {}): QaDraft {
  return {
    hook: "",
    body: "",
    cta: null,
    outboundLinkCount: 0,
    hashtagCount: 0,
    isThread: false,
    ...overrides,
  };
}

function input(overrides: Partial<QaInput> = {}): QaInput {
  return {
    identity: identity(),
    draft: draft(),
    recentHistory: [],
    ...overrides,
  };
}

describe("qaDraft — safety & guardrails", () => {
  it("BLOCKS a draft with a banned launch phrase", () => {
    const result = qaDraft(
      input({
        draft: draft({
          hook: "Introducing the next-gen analytics platform",
          body: "We're excited to share our revolutionary 10x improvement.",
        }),
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.blocks.some((f) => f.category === "safety")).toBe(true);
  });

  it("BLOCKS a draft with fabricated metrics", () => {
    const result = qaDraft(
      input({
        draft: draft({
          hook: "Honest update",
          body: "Trusted by 50,000 founders with $200,000 MRR.",
        }),
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.blocks.some((f) => f.code === "fabrication")).toBe(true);
  });

  it("WARNS on aggressive CTA wording", () => {
    const result = qaDraft(
      input({
        draft: draft({
          hook: "A short note on machine-readable trust",
          body: "Worth a read for engineers building agentic systems.",
          cta: "Sign up today, limited time!",
        }),
      }),
    );
    // Aggressive CTA = warn (guardrail), so verdict is at least warn
    expect(["warn", "block"]).toContain(result.verdict);
    expect(
      result.warnings.some((f) => f.code === "cta_too_aggressive") ||
        result.blocks.some((f) => f.code === "cta_too_aggressive"),
    ).toBe(true);
  });

  it("BLOCKS a draft whose hook duplicates a recent post hook", () => {
    const recent: QaRecentPost = {
      platform: "x",
      hook: "Most crawler logs still treat AI agents as noise",
      body: "old body",
      publishedAt: "2026-05-20T10:00:00Z",
    };
    const result = qaDraft(
      input({
        draft: draft({
          hook: "Most crawler logs still treat AI agents as noise",
          body: "Different body, same hook.",
        }),
        recentHistory: [recent],
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.findings.some((f) => f.code === "duplicate_hook")).toBe(true);
  });

  it("PASSES a clean operational observation with no recent dups", () => {
    const result = qaDraft(
      input({
        draft: draft({
          hook: "Quiet pattern this month:",
          body: "A few percent of requests in our stack now resolve to AI-class user-agents. The analytics layer wasn't built for them.",
        }),
      }),
    );
    expect(result.verdict).toBe("pass");
  });
});

describe("qaDraft — near-duplicate detection", () => {
  it("BLOCKS a near-duplicate on the same platform", () => {
    const recent: QaRecentPost = {
      platform: "x",
      hook: "The shape of agentic traffic",
      body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring.",
      publishedAt: "2026-05-20T10:00:00Z",
    };
    const result = qaDraft(
      input({
        draft: draft({
          hook: "The shape of agentic traffic, revisited",
          body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring.",
        }),
        recentHistory: [recent],
      }),
    );
    expect(result.verdict).toBe("block");
    expect(
      result.blocks.some((f) => f.code === "near_duplicate_same_platform"),
    ).toBe(true);
  });

  it("WARNS on a cross-platform near-duplicate (not blocks)", () => {
    const recent: QaRecentPost = {
      platform: "linkedin",
      hook: "Industry note on machine-readable trust",
      body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring.",
      publishedAt: "2026-05-20T10:00:00Z",
    };
    const result = qaDraft(
      input({
        identity: identity({ platform: "x" }),
        draft: draft({
          hook: "Most crawler logs still treat AI agents as noise.",
          body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring.",
        }),
        recentHistory: [recent],
      }),
    );
    expect(
      result.findings.some(
        (f) => f.code === "near_duplicate_cross_platform" && f.severity === "warn",
      ),
    ).toBe(true);
  });

  it("ALLOWS a different platform-native derivative (rewritten)", () => {
    const recent: QaRecentPost = {
      platform: "hashnode",
      hook: "An architecture note on observability for non-human traffic.",
      body: "Most analytics platforms answer the question who visited. We started asking: what understood? The architecture pivot starts with a shingle-keyed dedup layer.",
      publishedAt: "2026-05-18T10:00:00Z",
    };
    const result = qaDraft(
      input({
        identity: identity({ platform: "x" }),
        draft: draft({
          hook: "the interesting thing about agent traffic isn't that it's new",
          body: "spent the week reading bot logs. a few patterns worth writing down. the modern web has two audiences now, and most stacks only acknowledge one.",
        }),
        recentHistory: [recent],
      }),
    );
    expect(
      result.findings.find(
        (f) =>
          f.code === "near_duplicate_same_platform" ||
          f.code === "near_duplicate_cross_platform",
      ),
    ).toBeUndefined();
  });
});

describe("qaDraft — topic ownership", () => {
  it("BLOCKS architecture deep dive on Instagram", () => {
    const result = qaDraft(
      input({
        identity: identity({ platform: "instagram" }),
        draft: draft({
          hook: "Architecture note",
          body: "An architecture note. The data model is sharded by workspace id. We chose a consistency model that trades strong reads for write throughput; the decision record is below.",
        }),
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.blocks.some((f) => f.code === "topic_forbidden")).toBe(true);
  });

  it("ALLOWS architecture deep dive on Hashnode", () => {
    const result = qaDraft(
      input({
        identity: identity({ platform: "hashnode" }),
        draft: draft({
          hook: "How we shard the dedup pipeline",
          body: "The system design splits requests by workspace id. We chose a consistency model that trades strong reads for write throughput; the decision record below explains the trade-off between latency and freshness.",
        }),
      }),
    );
    expect(result.verdict).toBe("pass");
  });

  it("BLOCKS a launch announcement on Reddit", () => {
    const result = qaDraft(
      input({
        identity: identity({ platform: "reddit", handle: "u/Webmasterid-core" }),
        draft: draft({
          hook: "Now live",
          body: "Today we're launching the agent-aware analytics layer. Now available in public beta.",
        }),
      }),
    );
    expect(result.verdict).toBe("block");
  });

  it("ALLOWS a changelog on Telegram", () => {
    const result = qaDraft(
      input({
        identity: identity({ platform: "telegram", handle: "@webmasterid" }),
        draft: draft({
          hook: "This week",
          body: "Changelog — release notes for the week. We shipped two improvements to bot classification.",
        }),
      }),
    );
    expect(result.verdict).toBe("pass");
  });
});

describe("qaDraft — new-account safety mode", () => {
  it("BLOCKS a warming account from posting a link-heavy draft", () => {
    const result = qaDraft(
      input({
        identity: identity({ ageDays: 2, status: "warming" }),
        draft: draft({
          hook: "Quiet build update",
          body: "Read more here https://example.com and also https://x.com",
          outboundLinkCount: 2,
        }),
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.blocks.some((f) => f.code === "warming_link_cap")).toBe(true);
  });

  it("WARNS a warming account on hashtag spam", () => {
    const result = qaDraft(
      input({
        identity: identity({ ageDays: 5, status: "warming" }),
        draft: draft({
          hook: "Quiet build update",
          body: "A small note. #ai #seo #analytics #observability #webdev #agents",
        }),
      }),
    );
    expect(
      result.findings.some((f) => f.code === "warming_hashtag_cap"),
    ).toBe(true);
  });

  it("BLOCKS a thread on a warming X account", () => {
    const result = qaDraft(
      input({
        identity: identity({ ageDays: 1, status: "warming", platform: "x" }),
        draft: draft({
          hook: "Three things AI crawlers reveal",
          body: "1/ thread starts here",
          isThread: true,
        }),
      }),
    );
    expect(result.verdict).toBe("block");
    expect(result.blocks.some((f) => f.code === "warming_no_threads")).toBe(true);
  });

  it("ALLOWS a single calm observation on a warming X account", () => {
    const result = qaDraft(
      input({
        identity: identity({ ageDays: 5, status: "warming", platform: "x" }),
        draft: draft({
          hook: "Quiet pattern this month",
          body: "Bot traffic is now meaningfully different in shape from human traffic. Worth tracking through Q3.",
        }),
      }),
    );
    expect(result.verdict).toBe("pass");
  });
});

describe("qaDraft — verdict aggregation", () => {
  it("is deterministic: same input → same output", () => {
    const i = input({
      draft: draft({
        hook: "Quiet pattern this month",
        body: "A few percent of requests now resolve to AI-class user-agents.",
      }),
    });
    const a = qaDraft(i);
    const b = qaDraft(i);
    expect(a).toEqual(b);
  });

  it("does not mutate the input", () => {
    const i = input({
      draft: draft({ hook: "x", body: "y", cta: "z" }),
      recentHistory: [
        { platform: "x", hook: "x", body: "y", publishedAt: "2026-05-20T10:00:00Z" },
      ],
    });
    const before = JSON.stringify(i);
    qaDraft(i);
    expect(JSON.stringify(i)).toBe(before);
  });

  it("returns blocks/warnings/infos as partitions of findings", () => {
    const result = qaDraft(
      input({
        draft: draft({
          hook: "Industry note",
          body: "An architecture note. The data model is sharded by workspace id. We chose a consistency model.",
        }),
        identity: identity({ platform: "x" }),
      }),
    );
    const total =
      result.blocks.length + result.warnings.length + result.infos.length;
    expect(total).toBe(result.findings.length);
  });
});
