/**
 * PlatformNativePreview render tests.
 *
 * We use renderToStaticMarkup from react-dom/server (already
 * available in this Next.js codebase) to serialize the component
 * to HTML and assert against the markup. Avoids adding React
 * Testing Library as a new dependency.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PlatformNativePreview } from "./_platform-native-preview";
import { getCreativeDirection } from "@/core/platform-native";
import type { PlatformNativeDraft } from "@/core/platform-native";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

function draft(
  overrides: Partial<PlatformNativeDraft> & { platform: FounderPlatform },
): PlatformNativeDraft {
  const { platform, ...rest } = overrides;
  return {
    platform,
    title: null,
    hook: "",
    body: "",
    cta: null,
    format: "single_post",
    creativeDirection: getCreativeDirection(platform),
    riskLevel: "low",
    warnings: [],
    transformationNotes: [],
    ...rest,
  };
}

function render(d: PlatformNativeDraft): string {
  return renderToStaticMarkup(
    createElement(PlatformNativePreview, { draft: d }),
  );
}

// =====================================================================
// Core: every required field surfaces in the markup
// =====================================================================

describe("PlatformNativePreview — renders every required envelope field", () => {
  it("renders the platform label and format", () => {
    const html = render(
      draft({ platform: "x", body: "Body line." }),
    );
    expect(html).toContain("Preview for X");
    expect(html).toContain("Single post");
  });

  it("renders hook + body + cta when present", () => {
    const html = render(
      draft({
        platform: "linkedin",
        hook: "Refresh-token storage and incident rate are linked.",
        body: "Encrypted at rest. Per-workspace keys. Zero incidents.",
        cta: "Curious how others approached the rotation.",
      }),
    );
    expect(html).toContain(
      "Refresh-token storage and incident rate are linked.",
    );
    expect(html).toContain("Per-workspace keys");
    expect(html).toContain("Curious how others approached the rotation.");
  });

  it("renders title when the platform uses one", () => {
    const html = render(
      draft({
        platform: "devto",
        title: "Envelope encryption for refresh tokens",
        body: "...",
      }),
    );
    expect(html).toContain("Envelope encryption for refresh tokens");
  });

  it("renders risk level operator-facing label", () => {
    const high = render(draft({ platform: "x", riskLevel: "high" }));
    expect(high).toContain("High risk");
    const medium = render(draft({ platform: "x", riskLevel: "medium" }));
    expect(medium).toContain("Caution");
    const low = render(draft({ platform: "x", riskLevel: "low" }));
    expect(low).toContain("Low risk");
  });

  it("renders warnings block when warnings exist", () => {
    const html = render(
      draft({
        platform: "x",
        warnings: ["Identity is warming — extra caps apply."],
      }),
    );
    expect(html).toContain("Heads up");
    expect(html).toContain("Identity is warming");
  });

  it("omits warnings block when warnings array is empty", () => {
    const html = render(draft({ platform: "x" }));
    expect(html).not.toContain("Heads up");
  });

  it("renders transformation notes (operator-facing: 'Why this fits …')", () => {
    const html = render(
      draft({
        platform: "linkedin",
        transformationNotes: [
          "Operational lesson framed for senior engineers / buyers.",
        ],
      }),
    );
    expect(html).toContain("Why this fits LinkedIn");
    expect(html).toContain("Operational lesson");
  });
});

// =====================================================================
// Creative direction block — every field rendered, no fake-visual copy
// =====================================================================

describe("PlatformNativePreview — creative direction", () => {
  it("renders the visual type label (operator-facing)", () => {
    const html = render(draft({ platform: "linkedin" }));
    expect(html).toContain("Visual type:");
    expect(html).toContain("Carousel"); // LinkedIn carousel
  });

  it("renders the visual brief verbatim", () => {
    const html = render(draft({ platform: "telegram" }));
    expect(html).toContain("What to create:");
    expect(html).toContain("screenshot of the change");
  });

  it("renders media risk notes under 'Don't do'", () => {
    const html = render(draft({ platform: "instagram" }));
    expect(html).toContain("Don&#x27;t do"); // HTML-encoded apostrophe
    expect(html).toContain("Do not invent metrics");
  });

  it("never implies a visual exists in the preview itself", () => {
    // The preview must never say "the image shows" / "as you can see
    // in the screenshot" — it describes what the operator should
    // create. Sanity scan: no past-tense visual claims.
    const html = render(draft({ platform: "instagram" }));
    expect(html.toLowerCase()).not.toContain("the image shows");
    expect(html.toLowerCase()).not.toContain("as you can see in");
    expect(html.toLowerCase()).not.toContain("the screenshot shows");
    expect(html.toLowerCase()).not.toContain("the visual demonstrates");
  });
});

// =====================================================================
// mediaRequired — Instagram + YouTube emphasis
// =====================================================================

describe("PlatformNativePreview — mediaRequired emphasis", () => {
  it("Instagram preview shows 'Visual required' badge + incomplete warning", () => {
    const html = render(draft({ platform: "instagram" }));
    expect(html).toContain("Visual required");
    expect(html).toContain("not complete until you create and attach");
    expect(html).toContain('data-media-required="true"');
  });

  it("YouTube preview shows 'Visual required' badge + thumbnail brief", () => {
    const html = render(draft({ platform: "youtube" }));
    expect(html).toContain("Visual required");
    expect(html).toContain("Thumbnail");
    expect(html).toContain("not complete until you create and attach");
    expect(html).toContain('data-media-required="true"');
  });

  it("Reddit preview shows 'Optional' badge (mediaRequired=false)", () => {
    const html = render(draft({ platform: "reddit" }));
    expect(html).toContain("Optional");
    expect(html).not.toContain("Visual required");
    expect(html).toContain('data-media-required="false"');
  });

  it("X preview shows 'Optional' badge (mediaRequired=false)", () => {
    const html = render(draft({ platform: "x" }));
    expect(html).toContain("Optional");
    expect(html).toContain('data-media-required="false"');
  });
});

// =====================================================================
// Operator-facing language — no internal field names rendered
// =====================================================================

describe("PlatformNativePreview — operator-facing language", () => {
  it("does not surface internal enum names in rendered text", () => {
    const html = render(
      draft({
        platform: "x",
        body: "Body content.",
        warnings: ["Identity is warming"],
        transformationNotes: ["Concise standalone observation."],
      }),
    );
    // The component MAY include enum strings as data-* attributes
    // (for tests) — that's fine. Operator-visible TEXT must not.
    // Strip attributes for the visible-text check.
    const visible = html.replace(/data-[a-z-]+="[^"]*"/g, "");
    expect(visible).not.toContain("creativeDirection");
    expect(visible).not.toContain("transformationNotes");
    expect(visible).not.toContain("mediaRequired");
    expect(visible).not.toContain("platformNativeDraft");
    expect(visible).not.toContain("api_key_verify");
    expect(visible).not.toContain("personal_api_key");
  });
});

// =====================================================================
// Copy buttons — body / CTA / media brief
// =====================================================================

describe("PlatformNativePreview — copy buttons", () => {
  it("renders a body copy button when body has content", () => {
    const html = render(draft({ platform: "x", body: "Body content goes here." }));
    expect(html).toContain('aria-label="Copy body"');
  });

  it("renders a CTA copy button when CTA is present", () => {
    const html = render(
      draft({
        platform: "linkedin",
        body: "...",
        cta: "Curious how others approached this.",
      }),
    );
    expect(html).toContain('aria-label="Copy cta"');
  });

  it("does NOT render a CTA copy button when CTA is null", () => {
    const html = render(draft({ platform: "x", body: "...", cta: null }));
    expect(html).not.toContain('aria-label="Copy cta"');
  });

  it("renders a media-brief copy button (every platform's brief is non-empty)", () => {
    const html = render(draft({ platform: "instagram", body: "..." }));
    expect(html).toContain('aria-label="Copy brief"');
  });

  it("body copy button does not render when body is empty", () => {
    const html = render(draft({ platform: "x", body: "" }));
    expect(html).not.toContain('aria-label="Copy body"');
  });
});

// =====================================================================
// Per-platform smoke: every founder platform renders without error
// =====================================================================

const ALL_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "x",
  "bluesky",
  "linkedin",
  "threads",
  "instagram",
  "telegram",
  "devto",
  "hashnode",
  "youtube",
  "indie_hackers",
];

describe("PlatformNativePreview — smoke across all founder platforms", () => {
  it.each(ALL_PLATFORMS)("renders cleanly for %s", (platform) => {
    const html = render(
      draft({
        platform,
        body: "Sample body.",
        transformationNotes: ["Platform-shaped."],
      }),
    );
    expect(html.length).toBeGreaterThan(100);
    // Always carries the creative-direction block.
    expect(html).toContain("Media");
    expect(html).toContain("Visual type:");
  });
});
