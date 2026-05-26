import { describe, expect, it } from "vitest";
import {
  decideBlueskyApprovalShape,
  type BlueskyApprovalCheckInput,
} from "@/core/platform-native/adapters/bluesky/shape-binding";
import {
  legacyPlatformNativeShape,
  serializePlatformNativeShape,
} from "@/core/platform-native";

/**
 * Phase F6.2 — approval-action regression guards.
 *
 * The approval action (approvePlanItemAndHoldAction /
 * approvePlanItemAndScheduleAction) wraps decideBlueskyApprovalShape
 * behind a `platform === "bluesky"` guard. These tests pin the
 * Bluesky-only decisions; the action-level guard is asserted in
 * separate integration smoke (manual QA — Signal's server actions
 * are not easy to unit test without a Supabase fixture).
 *
 * Crucially, this file ASSERTS that other platforms are untouched
 * by asserting the wrapped decision function is platform-keyed:
 * passing a rawIntent that targets a non-Bluesky platform should
 * fall back to legacy_no_enforcement (Bluesky adapter only accepts
 * Bluesky shapes).
 */

function blueskyIntent(threadMode: "single_only" | "auto_thread_allowed") {
  return serializePlatformNativeShape({
    ...legacyPlatformNativeShape("bluesky"),
    intent: "new_post",
    threadMode,
    mediaMode: "none",
  });
}

function baseInput(over: Partial<BlueskyApprovalCheckInput> = {}): BlueskyApprovalCheckInput {
  return {
    rawIntent: blueskyIntent("single_only"),
    title: null,
    body: "short body that fits",
    creative: null,
    ...over,
  };
}

describe("approval binding — Bluesky behaviour", () => {
  it("legacy item (null intent) → no binding, no refusal", async () => {
    const r = await decideBlueskyApprovalShape({
      rawIntent: null,
      title: null,
      body: "anything",
      creative: null,
    });
    expect(r.kind).toBe("legacy_no_enforcement");
  });

  it("single_only + body fits → bind (operatorApprovedShapeHash persisted)", async () => {
    const r = await decideBlueskyApprovalShape(baseInput());
    expect(r.kind).toBe("bind");
    if (r.kind === "bind") {
      expect(r.serializedIntent.operatorApprovedShapeHash).toBe(r.payloadHash);
    }
  });

  it("single_only + body overflows → REFUSE (single_post_exceeds_budget)", async () => {
    const longBody = "A. ".repeat(200);
    const r = await decideBlueskyApprovalShape(baseInput({ body: longBody }));
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.blockers[0].code).toBe("single_post_exceeds_budget");
    }
  });

  it("auto_thread_allowed + long body → bind (thread approved)", async () => {
    const longBody = "A. ".repeat(200);
    const r = await decideBlueskyApprovalShape(
      baseInput({
        rawIntent: blueskyIntent("auto_thread_allowed"),
        body: longBody,
      }),
    );
    expect(r.kind).toBe("bind");
    if (r.kind === "bind") {
      expect(r.preview.format).toBe("thread");
      expect(r.preview.parts.length).toBeGreaterThan(1);
    }
  });

  it("creative attached without alt text → REFUSE", async () => {
    const r = await decideBlueskyApprovalShape(
      baseInput({
        creative: {
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: null,
          creativeType: "image",
        },
      }),
    );
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.blockers[0].code).toBe("creative_missing_alt_text");
    }
  });
});

describe("approval binding — platform isolation", () => {
  // The helper is Bluesky-specific. If a row's envelope claims a
  // different platform, the Bluesky adapter's shape parser refuses
  // it and we fall back to legacy mode — so other platforms get NO
  // accidental Bluesky-style enforcement.
  it("envelope claims platform=x → falls back to legacy (Bluesky parser refuses)", async () => {
    const xIntent = {
      version: 1,
      platform: "x",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      expectedPartCount: null,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: null,
    };
    const r = await decideBlueskyApprovalShape({
      rawIntent: xIntent,
      title: null,
      body: "irrelevant",
      creative: null,
    });
    // parsePlatformNativeShape returns null on platform mismatch,
    // which the helper folds to legacy_no_enforcement.
    expect(r.kind).toBe("legacy_no_enforcement");
  });
});
