/**
 * Renders the diagnostics panel via renderToStaticMarkup (same
 * pattern as `_copy-button.test.ts`) and asserts the operator-facing
 * content is present.
 */

import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlueskyOutcomeDiagnostics } from "./bluesky-outcome-diagnostics";
import type { BlueskyOutcomeSummary } from "@/core/publishing/bluesky-outcome-summary";

function summary(
  over: Partial<BlueskyOutcomeSummary> = {},
): BlueskyOutcomeSummary {
  return {
    status: { value: "published", source: "execution_item" },
    reasonCode: { value: "ok", source: "execution_item" },
    reasonDetail: { value: null, source: "absent" },
    externalUrl: {
      value: "https://bsky.app/profile/op.bsky.social/post/abc",
      source: "execution_item",
    },
    mediaAttached: { value: "yes", source: "execution_log" },
    threadLength: { value: 1, source: "execution_log" },
    threadPositionFailed: { value: null, source: "absent" },
    endpoint: { value: null, source: "absent" },
    httpStatus: { value: null, source: "absent" },
    atprotoError: { value: null, source: "absent" },
    atprotoMessage: { value: null, source: "absent" },
    atprotoResponseBody: { value: null, source: "absent" },
    did: { value: "did:plc:test", source: "execution_log" },
    rootUri: { value: null, source: "absent" },
    creativeId: { value: null, source: "absent" },
    transformationNotes: { value: [], source: "absent" },
    divergence: null,
    ...over,
  };
}

function render(s: BlueskyOutcomeSummary): string {
  return renderToStaticMarkup(
    React.createElement(BlueskyOutcomeDiagnostics, { summary: s }),
  );
}

// ---------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — status badges", () => {
  it("published → 'Published' chip + external link", () => {
    const html = render(summary());
    expect(html).toContain("Published");
    expect(html).toContain(
      "https://bsky.app/profile/op.bsky.social/post/abc",
    );
  });

  it("failed → 'Failed' chip with reason_code", () => {
    const html = render(
      summary({
        status: { value: "failed", source: "execution_item" },
        reasonCode: { value: "platform_api_error", source: "execution_log" },
        reasonDetail: {
          value:
            "Bluesky: createRecord failed: InvalidRequest — Record/text must not be longer than 300 graphemes",
          source: "execution_item",
        },
      }),
    );
    expect(html).toContain("Failed");
    expect(html).toContain("platform_api_error");
    expect(html).toContain("300 graphemes");
  });

  it("blocked → 'Blocked' chip with reason_code", () => {
    const html = render(
      summary({
        status: { value: "blocked", source: "execution_item" },
        reasonCode: {
          value: "creative_missing_alt_text",
          source: "execution_log",
        },
        reasonDetail: {
          value:
            "Bluesky: Approved creative is missing alt text. Add a one-line description so the image is accessible before publishing.",
          source: "execution_item",
        },
      }),
    );
    expect(html).toContain("Blocked");
    expect(html).toContain("creative_missing_alt_text");
    expect(html).toContain("alt text");
  });

  it("scheduled → 'Scheduled' chip, no permalink", () => {
    const html = render(
      summary({
        status: { value: "scheduled", source: "execution_item" },
        reasonCode: { value: null, source: "absent" },
        externalUrl: { value: null, source: "absent" },
        mediaAttached: { value: "unknown", source: "absent" },
      }),
    );
    expect(html).toContain("Scheduled");
    expect(html).not.toContain("bsky.app/profile");
  });
});

// ---------------------------------------------------------------------
// Media attached chip
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — media chip", () => {
  it("yes → 'Image attached'", () => {
    const html = render(summary());
    expect(html).toContain("Image attached");
  });

  it("no → 'Text-only'", () => {
    const html = render(
      summary({ mediaAttached: { value: "no", source: "execution_log" } }),
    );
    expect(html).toContain("Text-only");
  });

  it("unknown → 'Media status not recorded' (amber)", () => {
    const html = render(
      summary({ mediaAttached: { value: "unknown", source: "absent" } }),
    );
    expect(html).toContain("Media status not recorded");
  });
});

// ---------------------------------------------------------------------
// Diagnostic fields
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — diagnostic fields", () => {
  it("media_upload_failed: endpoint + http_status + atproto_error + creative_id", () => {
    const html = render(
      summary({
        status: { value: "failed", source: "execution_item" },
        reasonCode: { value: "media_upload_failed", source: "execution_log" },
        endpoint: { value: "uploadBlob", source: "execution_log" },
        httpStatus: { value: 400, source: "execution_log" },
        atprotoError: { value: "InvalidRequest", source: "execution_log" },
        atprotoMessage: {
          value: "Blob size exceeds maximum",
          source: "execution_log",
        },
        creativeId: { value: "c-123", source: "execution_log" },
        mediaAttached: { value: "no", source: "execution_log" },
      }),
    );
    expect(html).toContain("media_upload_failed");
    expect(html).toContain("com.atproto.repo.uploadBlob");
    expect(html).toContain("400");
    expect(html).toContain("InvalidRequest");
    expect(html).toContain("Blob size exceeds maximum");
    expect(html).toContain("c-123");
  });

  it("createRecord thread failure: failed-on-part X of Y rendered", () => {
    const html = render(
      summary({
        status: { value: "failed", source: "execution_item" },
        endpoint: { value: "createRecord", source: "execution_log" },
        threadLength: { value: 5, source: "execution_log" },
        threadPositionFailed: { value: 3, source: "execution_log" },
      }),
    );
    expect(html).toContain("Failed on part");
    expect(html).toContain("3");
    expect(html).toContain("5");
  });

  it("DID is rendered (public identifier)", () => {
    const html = render(
      summary({
        did: { value: "did:plc:vngr5gncxccrjahhabqph5zc", source: "execution_log" },
      }),
    );
    expect(html).toContain("did:plc:vngr5gncxccrjahhabqph5zc");
  });
});

// ---------------------------------------------------------------------
// Source-of-truth labels
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — source-of-truth provenance", () => {
  it("execution_log fields render 'source: execution_logs.metadata'", () => {
    const html = render(
      summary({
        endpoint: { value: "createRecord", source: "execution_log" },
      }),
    );
    expect(html).toContain("execution_logs.metadata");
  });

  it("execution_item fields render 'source: execution_items.metadata.publish_outcome'", () => {
    // The status-row chips (reasonCode badge, status badge) are
    // compact and don't carry inline source labels. Fields rendered
    // in the grid (and the reasonDetail block) DO carry source tags.
    const html = render(
      summary({
        reasonDetail: {
          value:
            "Bluesky: createRecord failed: InvalidRequest — Record/text must not be longer than 300 graphemes",
          source: "execution_item",
        },
      }),
    );
    expect(html).toContain(
      "execution_items.metadata.publish_outcome",
    );
  });

  it("preview_rederivation source labelled on transformation notes", () => {
    const html = render(
      summary({
        transformationNotes: {
          value: ["Removed blog-style intro.", "Stripped Markdown."],
          source: "preview_rederivation",
        },
      }),
    );
    expect(html).toContain("Removed blog-style intro.");
    expect(html).toContain("Stripped Markdown.");
    expect(html).toContain("deterministic adapter re-derived");
  });

  it("'absent' fields still labelled on media_attached chip", () => {
    const html = render(
      summary({
        mediaAttached: { value: "unknown", source: "absent" },
      }),
    );
    expect(html).toContain("not recorded");
  });
});

// ---------------------------------------------------------------------
// Divergence warning
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — divergence warning", () => {
  it("expected_media_missing renders the warning prominently", () => {
    const html = render(
      summary({
        status: { value: "published", source: "execution_item" },
        mediaAttached: { value: "no", source: "execution_log" },
        divergence: {
          kind: "expected_media_missing",
          message:
            "Approved creative did not attach. The plan item has an approved image, but the execution log records media_attached=false.",
        },
      }),
    );
    expect(html).toContain("did not attach");
    expect(html).toContain("⚠");
  });

  it("media_status_not_recorded renders the warning", () => {
    const html = render(
      summary({
        status: { value: "published", source: "execution_item" },
        mediaAttached: { value: "unknown", source: "absent" },
        divergence: {
          kind: "media_status_not_recorded",
          message:
            "Media status not recorded for this publish. Cannot confirm whether the image attached.",
        },
      }),
    );
    expect(html).toContain("Cannot confirm");
  });

  it("no divergence → no warning rendered", () => {
    const html = render(summary());
    expect(html).not.toContain("⚠");
  });
});

// ---------------------------------------------------------------------
// Secret-leakage safety
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — no secret leakage", () => {
  it("Bearer / JWT / app password values never appear in rendered HTML", () => {
    // We hand the component a summary that has token-shaped strings
    // in the response body. The summary builder re-redacts them
    // before they reach this component, but the test still asserts
    // the rendered HTML contains no token shape — defense in depth.
    const html = render(
      summary({
        atprotoResponseBody: {
          value:
            '{"error":"InvalidRequest","message":"Bearer [REDACTED] presented"}',
          source: "execution_log",
        },
      }),
    );
    expect(html).toContain("Bearer [REDACTED]");
    expect(html).not.toMatch(/Bearer\s+eyJ/);
    expect(html).not.toMatch(/access_token\s*[:=]\s*["a-zA-Z0-9]/);
    expect(html).not.toMatch(/Authorization:\s+(?!\[REDACTED\])/);
  });

  it("atproto_response_body lives behind a <details> disclosure", () => {
    const html = render(
      summary({
        atprotoResponseBody: {
          value: '{"error":"InvalidRequest"}',
          source: "execution_log",
        },
      }),
    );
    expect(html).toContain("<details");
    expect(html).toContain("AT Proto response body (redacted)");
  });

  it("absent atproto_response_body → no <details> disclosure rendered", () => {
    const html = render(summary());
    expect(html).not.toContain("AT Proto response body");
  });
});

// ---------------------------------------------------------------------
// Adapter notes
// ---------------------------------------------------------------------

describe("BlueskyOutcomeDiagnostics — adapter applied section", () => {
  it("empty notes → section is NOT rendered", () => {
    const html = render(summary());
    expect(html).not.toContain("Adapter applied");
  });

  it("non-empty notes → section rendered with each note", () => {
    const html = render(
      summary({
        transformationNotes: {
          value: [
            "Removed blog-style intro.",
            "Removed trailing CTA.",
            "Title ignored — Bluesky has no post-title concept.",
          ],
          source: "preview_rederivation",
        },
      }),
    );
    expect(html).toContain("Adapter applied");
    expect(html).toContain("Removed blog-style intro.");
    expect(html).toContain("Removed trailing CTA.");
    expect(html).toContain("Title ignored");
  });
});
