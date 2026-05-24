import { describe, expect, it } from "vitest";
import { qaDraft } from "./qa-draft";
import type { QaInput } from "./types";

function input(overrides: Partial<QaInput> = {}): QaInput {
  return {
    identity: {
      platform: "x",
      ageDays: 120,
      displayName: "WebmasterID",
      handle: "webmasterid",
      status: "active",
    },
    draft: {
      hook: "Refresh-token storage and incident rate are linked.",
      body:
        "Encrypted at rest. Per-workspace keys. Zero incidents since.",
      cta: null,
      outboundLinkCount: 0,
      hashtagCount: 0,
      isThread: false,
    },
    recentHistory: [],
    ...overrides,
  };
}

describe("qaDraft — sibling cross-platform copypaste detection", () => {
  it("flags a shared opening hook across platforms (Jaccard >= 0.6)", () => {
    const result = qaDraft(
      input({
        siblingDrafts: [
          {
            platform: "linkedin",
            hook: "Refresh-token storage and incident rate are linked.",
            body: "different body altogether",
            cta: null,
          },
        ],
      }),
    );
    expect(
      result.findings.some(
        (f) =>
          f.category === "cross_platform_copypaste" && f.code === "shared_hook",
      ),
    ).toBe(true);
  });

  it("flags identical CTA across platforms", () => {
    const result = qaDraft(
      input({
        draft: {
          hook: "X-shaped hook.",
          body: "X body",
          cta: "Curious how others handle this.",
          outboundLinkCount: 0,
          hashtagCount: 0,
          isThread: false,
        },
        siblingDrafts: [
          {
            platform: "linkedin",
            hook: "Different LinkedIn hook.",
            body: "LI body",
            cta: "Curious how others handle this.",
          },
        ],
      }),
    );
    expect(
      result.findings.some(
        (f) =>
          f.category === "cross_platform_copypaste" && f.code === "shared_cta",
      ),
    ).toBe(true);
  });

  it("no siblings supplied → no cross_platform findings (backward compat)", () => {
    const result = qaDraft(input());
    expect(
      result.findings.filter(
        (f) => f.category === "cross_platform_copypaste",
      ),
    ).toEqual([]);
  });

  it("siblings on the SAME platform as the candidate are ignored", () => {
    const result = qaDraft(
      input({
        siblingDrafts: [
          {
            platform: "x", // same as candidate
            hook: "Refresh-token storage and incident rate are linked.",
            body: "x body",
            cta: null,
          },
        ],
      }),
    );
    expect(
      result.findings.filter(
        (f) => f.category === "cross_platform_copypaste",
      ),
    ).toEqual([]);
  });

  it("sibling findings are warn-severity (never block — detection only)", () => {
    const result = qaDraft(
      input({
        siblingDrafts: [
          {
            platform: "linkedin",
            hook: "Refresh-token storage and incident rate are linked.",
            body: "li body",
            cta: null,
          },
        ],
      }),
    );
    const cpcFindings = result.findings.filter(
      (f) => f.category === "cross_platform_copypaste",
    );
    expect(cpcFindings.length).toBeGreaterThan(0);
    for (const f of cpcFindings) {
      expect(f.severity).toBe("warn");
    }
  });
});
