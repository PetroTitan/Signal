import { describe, expect, it } from "vitest";
import {
  buildBlueskyOutcomeSummary,
  type BlueskyOutcomeExecutionItemInput,
  type BlueskyOutcomeExecutionLogInput,
} from "./bluesky-outcome-summary";
import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";

/**
 * Pure tests for the Bluesky outcome summary builder. The summary is
 * the single semantic layer the UI reads — these tests pin every
 * branch of "which source wins", "how is the field rendered", and
 * "when does divergence fire."
 */

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function execItem(
  over: Partial<BlueskyOutcomeExecutionItemInput> = {},
): BlueskyOutcomeExecutionItemInput {
  return {
    status: "scheduled",
    metadata: null,
    body: "Hi there.",
    title: null,
    ...over,
  };
}

function publishOutcomeMetadata(over: Record<string, unknown> = {}) {
  return {
    publish_outcome: {
      status: "published",
      reason_code: "ok",
      reason_detail: null,
      external_id: "at://did:plc:test/app.bsky.feed.post/abc",
      external_url: "https://bsky.app/profile/op/post/abc",
      ...over,
    },
  };
}

function logRow(
  over: Partial<BlueskyOutcomeExecutionLogInput> = {},
): BlueskyOutcomeExecutionLogInput {
  return {
    eventType: "item.completed",
    message: "[publisher] published — ok",
    metadata: null,
    createdAt: "2026-05-25T20:55:09Z",
    ...over,
  };
}

function approvedCreative(
  over: Partial<WeeklyPlanItemCreative> = {},
): WeeklyPlanItemCreative {
  return {
    id: "c-1",
    workspaceId: "ws-1",
    weeklyPlanItemId: "pi-1",
    creativeType: "image",
    sourceType: "uploaded",
    sourceUrl: null,
    assetUrl: "https://example.com/image.jpg",
    prompt: null,
    altText: "An image",
    license: null,
    attribution: null,
    riskNotes: null,
    status: "approved",
    metadata: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    ...over,
  } as unknown as WeeklyPlanItemCreative;
}

// ---------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — overall status", () => {
  it("completed → published", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("published");
    expect(r.status.source).toBe("execution_item");
  });

  it("failed → failed", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "failed" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("failed");
  });

  it("blocked → blocked", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "blocked" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("blocked");
  });

  it("scheduled → scheduled", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "scheduled" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("scheduled");
  });

  it("running / ready / authorized / pending_authorization → in_flight", () => {
    for (const s of ["running", "ready", "authorized", "pending_authorization"]) {
      const r = buildBlueskyOutcomeSummary({
        executionItem: execItem({ status: s }),
        latestTerminalLog: null,
        planItemCreatives: [],
      });
      expect(r.status.value).toBe("in_flight");
    }
  });

  it("unrecognized status → unknown", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "some_future_status" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("unknown");
  });
});

// ---------------------------------------------------------------------
// Source-of-truth prioritization
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — execution_log wins over execution_item", () => {
  it("reason_code in both → log wins, source=execution_log", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "failed",
        metadata: publishOutcomeMetadata({ reason_code: "OLD" }),
      }),
      latestTerminalLog: logRow({
        eventType: "item.failed",
        metadata: { reason_code: "NEW", endpoint: "createRecord" },
      }),
      planItemCreatives: [],
    });
    expect(r.reasonCode.value).toBe("NEW");
    expect(r.reasonCode.source).toBe("execution_log");
  });

  it("reason_code only in execution_item → exec wins", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "failed",
        metadata: publishOutcomeMetadata({ reason_code: "platform_api_error" }),
      }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.reasonCode.value).toBe("platform_api_error");
    expect(r.reasonCode.source).toBe("execution_item");
  });

  it("neither has the field → absent", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "scheduled" }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.reasonCode.source).toBe("absent");
    expect(r.reasonCode.value).toBe(null);
  });
});

// ---------------------------------------------------------------------
// Bluesky diagnostic fields
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — bluesky diagnostic fields", () => {
  it("media_attached=true → 'yes' / execution_log", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed" }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: { media_attached: true },
      }),
      planItemCreatives: [],
    });
    expect(r.mediaAttached.value).toBe("yes");
    expect(r.mediaAttached.source).toBe("execution_log");
  });

  it("media_attached=false → 'no' / execution_log", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed" }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: { media_attached: false },
      }),
      planItemCreatives: [],
    });
    expect(r.mediaAttached.value).toBe("no");
    expect(r.mediaAttached.source).toBe("execution_log");
  });

  it("media_attached missing → 'unknown' / absent", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed" }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: {},
      }),
      planItemCreatives: [],
    });
    expect(r.mediaAttached.value).toBe("unknown");
    expect(r.mediaAttached.source).toBe("absent");
  });

  it("media_upload_failed shape: endpoint=uploadBlob, http_status, atproto_error, creative_id", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "failed",
        metadata: publishOutcomeMetadata({
          status: "failed",
          reason_code: "media_upload_failed",
          reason_detail: "Bluesky: uploadBlob failed: InvalidRequest — Blob size exceeds maximum",
        }),
      }),
      latestTerminalLog: logRow({
        eventType: "item.failed",
        metadata: {
          reason_code: "media_upload_failed",
          endpoint: "uploadBlob",
          http_status: 400,
          atproto_error: "InvalidRequest",
          atproto_message: "Blob size exceeds maximum",
          creative_id: "c-1",
        },
      }),
      planItemCreatives: [],
    });
    expect(r.reasonCode.value).toBe("media_upload_failed");
    expect(r.endpoint.value).toBe("uploadBlob");
    expect(r.httpStatus.value).toBe(400);
    expect(r.atprotoError.value).toBe("InvalidRequest");
    expect(r.atprotoMessage.value).toBe("Blob size exceeds maximum");
    expect(r.creativeId.value).toBe("c-1");
  });

  it("createRecord failure shape: thread_position_failed surfaced", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "failed" }),
      latestTerminalLog: logRow({
        eventType: "item.failed",
        metadata: {
          endpoint: "createRecord",
          http_status: 400,
          thread_position_failed: 3,
          thread_total: 5,
          atproto_error: "InvalidRequest",
          atproto_message: "Record/text must not be longer than 300 graphemes",
        },
      }),
      planItemCreatives: [],
    });
    expect(r.endpoint.value).toBe("createRecord");
    expect(r.threadPositionFailed.value).toBe(3);
    expect(r.atprotoMessage.value).toMatch(/300 graphemes/);
  });

  it("creative_missing_alt_text → reason code from execution_item, creative_id surfaced", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "blocked",
        metadata: publishOutcomeMetadata({
          status: "blocked",
          reason_code: "creative_missing_alt_text",
          reason_detail:
            "Bluesky: Approved creative is missing alt text. Add a one-line description so the image is accessible before publishing.",
        }),
      }),
      latestTerminalLog: logRow({
        eventType: "item.blocked",
        metadata: {
          reason_code: "creative_missing_alt_text",
          creative_id: "c-1",
        },
      }),
      planItemCreatives: [],
    });
    expect(r.status.value).toBe("blocked");
    expect(r.reasonCode.value).toBe("creative_missing_alt_text");
    expect(r.creativeId.value).toBe("c-1");
  });
});

// ---------------------------------------------------------------------
// transformationNotes — re-derivation
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — transformation notes (re-derived)", () => {
  it("body with blog intro → notes include 'Removed blog-style intro.' with source=preview_rederivation", () => {
    const body =
      "In this post, I'll explain our retry fix. We switched to exponential backoff with jitter. Latency dropped 40% during the next incident.";
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed", body }),
      latestTerminalLog: logRow({ eventType: "item.completed" }),
      planItemCreatives: [],
    });
    expect(r.transformationNotes.value).toContain(
      "Removed blog-style intro.",
    );
    expect(r.transformationNotes.source).toBe("preview_rederivation");
  });

  it("body with no patterns → empty notes, source=absent", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "completed",
        body: "Latency dropped 40% after we switched to jittered backoff. Next quarter: dead-lettering.",
      }),
      latestTerminalLog: logRow({ eventType: "item.completed" }),
      planItemCreatives: [],
    });
    expect(r.transformationNotes.value).toEqual([]);
    expect(r.transformationNotes.source).toBe("absent");
  });

  it("null body → empty notes, no crash", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed", body: null }),
      latestTerminalLog: null,
      planItemCreatives: [],
    });
    expect(r.transformationNotes.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Divergence detection
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — divergence", () => {
  it("approved creative + completed + media_attached=false → expected_media_missing", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "completed",
        metadata: publishOutcomeMetadata(),
      }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: { media_attached: false },
      }),
      planItemCreatives: [approvedCreative()],
    });
    expect(r.divergence?.kind).toBe("expected_media_missing");
    expect(r.divergence?.message).toMatch(/Approved creative did not attach/);
  });

  it("approved creative + completed + media_attached missing → media_status_not_recorded", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "completed",
        metadata: publishOutcomeMetadata(),
      }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: {},
      }),
      planItemCreatives: [approvedCreative()],
    });
    expect(r.divergence?.kind).toBe("media_status_not_recorded");
  });

  it("approved creative + completed + media_attached=true → no divergence", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "completed",
        metadata: publishOutcomeMetadata(),
      }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: { media_attached: true },
      }),
      planItemCreatives: [approvedCreative()],
    });
    expect(r.divergence).toBe(null);
  });

  it("no approved creative + completed + media_attached=false → no divergence", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({
        status: "completed",
        metadata: publishOutcomeMetadata(),
      }),
      latestTerminalLog: logRow({
        eventType: "item.completed",
        metadata: { media_attached: false },
      }),
      planItemCreatives: [],
    });
    expect(r.divergence).toBe(null);
  });

  it("failed publish + approved creative → no divergence (only fires on completed)", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "failed" }),
      latestTerminalLog: logRow({
        eventType: "item.failed",
        metadata: { media_attached: false },
      }),
      planItemCreatives: [approvedCreative()],
    });
    expect(r.divergence).toBe(null);
  });

  it("blocked-creative (missing alt) does NOT register as divergence", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "blocked" }),
      latestTerminalLog: logRow({
        eventType: "item.blocked",
        metadata: { media_attached: false, reason_code: "creative_missing_alt_text" },
      }),
      planItemCreatives: [approvedCreative({ altText: "" })],
    });
    expect(r.divergence).toBe(null);
  });
});

// ---------------------------------------------------------------------
// No leakage — atproto_response_body is re-redacted defensively
// ---------------------------------------------------------------------

describe("buildBlueskyOutcomeSummary — no token leakage", () => {
  it("atproto_response_body with a Bearer token is re-redacted on the summary", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "failed" }),
      latestTerminalLog: logRow({
        eventType: "item.failed",
        metadata: {
          atproto_response_body_truncated:
            "Bearer eyJabcdefghijklmnopqrstuvwxyz.long.token presented",
        },
      }),
      planItemCreatives: [],
    });
    expect(r.atprotoResponseBody.value).toContain("Bearer [REDACTED]");
    expect(r.atprotoResponseBody.value).not.toContain("eyJabcdefghijkl");
  });

  it("atproto_response_body missing → null (no spurious values)", () => {
    const r = buildBlueskyOutcomeSummary({
      executionItem: execItem({ status: "completed" }),
      latestTerminalLog: logRow({ metadata: {} }),
      planItemCreatives: [],
    });
    expect(r.atprotoResponseBody.value).toBe(null);
    expect(r.atprotoResponseBody.source).toBe("absent");
  });
});
