import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  RecommendationRow,
  SignalCard,
  STATE_BADGE,
  STATE_LABEL,
} from "./_signal-card";
import type { HealthSignal, Recommendation, SignalState } from "@/core/intelligence";
import { containsCausalClaim } from "@/core/intelligence";

const ALL_STATES: SignalState[] = [
  "normal",
  "advisory",
  "insufficient_data",
  "unavailable",
  "stale",
  "rate_limited",
  "provider_error",
];

function signal(over: Partial<HealthSignal> = {}): HealthSignal {
  return {
    key: "audience",
    label: "Audience",
    state: "advisory",
    value: "1 follower",
    evidence:
      "1 follower. With effectively no audience, near-zero engagement is the expected outcome.",
    timeframe: "current",
    source: "bluesky_getprofile",
    confidence: "high",
    ...over,
  };
}

describe("every signal state is renderable", () => {
  it("has a label and a badge class for each", () => {
    for (const state of ALL_STATES) {
      expect(STATE_LABEL[state], state).toBeTruthy();
      expect(STATE_BADGE[state], state).toMatch(/^badge badge-[a-z]+$/);
    }
  });

  it("renders each state without throwing", () => {
    for (const state of ALL_STATES) {
      const html = renderToStaticMarkup(createElement(SignalCard, { signal: signal({ state }) }));
      expect(html).toContain(STATE_LABEL[state]);
    }
  });
});

describe("the card never fabricates a number", () => {
  it("renders no value element when the signal has none", () => {
    const html = renderToStaticMarkup(
      createElement(SignalCard, {
        signal: signal({ state: "unavailable", value: null, evidence: "Follower count has not been read." }),
      }),
    );
    expect(html).not.toContain("stat-value");
    expect(html).not.toMatch(/>0</);
  });

  it("shows an unavailable metric as words, not as zero", () => {
    const html = renderToStaticMarkup(
      createElement(SignalCard, {
        signal: signal({
          key: "interaction_visibility",
          label: "What this platform reports",
          state: "normal",
          value: "no impressions",
          evidence:
            "Bluesky reports likes, replies, reposts, quotes and bookmarks. It does not expose impressions, views or reach.",
        }),
      }),
    );
    expect(html).toContain("no impressions");
    expect(html).not.toMatch(/>0 impressions</);
  });
});

describe("every card carries its provenance", () => {
  it("shows timeframe, source and confidence", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal: signal() }));
    expect(html).toContain("current");
    expect(html).toContain("bluesky_getprofile");
    expect(html).toContain("confidence: high");
  });

  it("uses only CSS classes the design system defines", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal: signal() }));
    const componentClasses = Array.from(html.matchAll(/class="([^"]+)"/g))
      .flatMap((m) => m[1].split(/\s+/))
      .filter((c) => /^(btn|badge|card|input|stat-label|stat-value|section-title|row-divider|nav-link|nav-item-active)(-[a-z0-9-]+)?$/.test(c));
    for (const c of componentClasses) {
      expect(
        ["badge", "badge-neutral", "badge-medium", "badge-info", "badge-high", "stat-label", "stat-value", "row-divider", "card", "card-padded", "section-title"],
        `undefined component class: ${c}`,
      ).toContain(c);
    }
  });
});

describe("recommendations render as advice", () => {
  const recommendation: Recommendation = {
    kind: "engage_manually",
    urgency: "when_convenient",
    action: "Reply to people in your own timeline rather than publishing another post today. Signal will not do this for you.",
    rationale: "Conversation is how a small account acquires an audience.",
    basedOn: ["audience"],
    automatable: false,
  };

  it("renders the action and the rationale", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRow, { recommendation }));
    expect(html).toContain("Reply to people in your own timeline");
    expect(html).toContain("Conversation is how a small account");
  });

  it("renders no button or link that could perform the action", () => {
    // Advice only: there must be no affordance that makes Signal act.
    const html = renderToStaticMarkup(createElement(RecommendationRow, { recommendation }));
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  it("emits no causal claim", () => {
    const html = renderToStaticMarkup(createElement(RecommendationRow, { recommendation }));
    expect(containsCausalClaim(html)).toBe(false);
  });
});

describe("mobile layout", () => {
  it("lets long values wrap instead of widening the page", () => {
    const html = renderToStaticMarkup(
      createElement(SignalCard, {
        signal: signal({ value: "median 0, n=12 across a very long descriptive label" }),
      }),
    );
    expect(html).toContain("break-words");
  });

  it("wraps the label/badge row rather than overflowing at narrow widths", () => {
    const html = renderToStaticMarkup(createElement(SignalCard, { signal: signal() }));
    expect(html).toContain("flex-wrap");
  });
});
