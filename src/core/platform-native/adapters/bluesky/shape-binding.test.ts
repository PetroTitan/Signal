import { describe, expect, it } from "vitest";
import {
  decideBlueskyApprovalShape,
  decideBlueskyPublishGate,
} from "./shape-binding";
import {
  computeProviderPayloadHash,
  legacyPlatformNativeShape,
  serializePlatformNativeShape,
  type PlatformNativeShape,
} from "../..";
import { blueskyAdapter } from "./index";

// =====================================================================
// Helpers — build raw intent envelopes the way the DB would store them
// =====================================================================

function rawIntent(over: Partial<PlatformNativeShape> = {}): Record<string, unknown> {
  return serializePlatformNativeShape({
    ...legacyPlatformNativeShape("bluesky"),
    intent: "new_post",
    threadMode: "auto_thread_allowed",
    mediaMode: "none",
    ...over,
  });
}

// =====================================================================
// decideBlueskyApprovalShape — REFUSE on single_only overflow
// =====================================================================

describe("decideBlueskyApprovalShape — single_only enforcement", () => {
  it("rawIntent=null → legacy_no_enforcement (caller skips persistence)", async () => {
    const r = await decideBlueskyApprovalShape({
      rawIntent: null,
      title: null,
      body: "hello",
      creative: null,
    });
    expect(r.kind).toBe("legacy_no_enforcement");
  });

  it("short body + single_only → bind (single post fits)", async () => {
    const r = await decideBlueskyApprovalShape({
      rawIntent: rawIntent({ threadMode: "single_only" }),
      title: null,
      body: "short post",
      creative: null,
    });
    expect(r.kind).toBe("bind");
    if (r.kind === "bind") {
      expect(r.preview.format).toBe("single_post");
      expect(r.payloadHash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
      expect(r.serializedIntent.operatorApprovedShapeHash).toBe(r.payloadHash);
    }
  });

  it("long body + single_only → REFUSE with single_post_exceeds_budget", async () => {
    const longBody = "A. ".repeat(200); // > 300 graphemes
    const r = await decideBlueskyApprovalShape({
      rawIntent: rawIntent({ threadMode: "single_only" }),
      title: null,
      body: longBody,
      creative: null,
    });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.blockers.map((b) => b.code)).toContain(
        "single_post_exceeds_budget",
      );
    }
  });

  it("long body + auto_thread_allowed → bind (thread is the chosen shape)", async () => {
    const longBody = "A. ".repeat(200);
    const r = await decideBlueskyApprovalShape({
      rawIntent: rawIntent({ threadMode: "auto_thread_allowed" }),
      title: null,
      body: longBody,
      creative: null,
    });
    expect(r.kind).toBe("bind");
    if (r.kind === "bind") {
      expect(r.preview.format).toBe("thread");
      expect(r.preview.parts.length).toBeGreaterThan(1);
    }
  });

  it("creative without altText → REFUSE with creative_missing_alt_text", async () => {
    const r = await decideBlueskyApprovalShape({
      rawIntent: rawIntent({ threadMode: "single_only" }),
      title: null,
      body: "short",
      creative: {
        assetUrl: "https://example.com/x.jpg",
        sourceUrl: null,
        altText: null,
        creativeType: "image",
      },
    });
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") {
      expect(r.blockers.map((b) => b.code)).toContain(
        "creative_missing_alt_text",
      );
    }
  });

  it("malformed raw envelope → falls back to legacy (no enforcement, no wedge)", async () => {
    const r = await decideBlueskyApprovalShape({
      rawIntent: { wrong: "shape" },
      title: null,
      body: "hello",
      creative: null,
    });
    expect(r.kind).toBe("legacy_no_enforcement");
  });

  it("bound hash is deterministic — same input twice gives same hash", async () => {
    const args = {
      rawIntent: rawIntent({ threadMode: "single_only" }),
      title: null,
      body: "deterministic body",
      creative: null,
    };
    const r1 = await decideBlueskyApprovalShape(args);
    const r2 = await decideBlueskyApprovalShape(args);
    expect(r1.kind).toBe("bind");
    expect(r2.kind).toBe("bind");
    if (r1.kind === "bind" && r2.kind === "bind") {
      expect(r1.payloadHash).toBe(r2.payloadHash);
    }
  });

  it("body change between approvals → different hash", async () => {
    const base = {
      rawIntent: rawIntent({ threadMode: "single_only" }),
      title: null,
      creative: null,
    };
    const r1 = await decideBlueskyApprovalShape({ ...base, body: "first" });
    const r2 = await decideBlueskyApprovalShape({ ...base, body: "second" });
    expect(r1.kind).toBe("bind");
    expect(r2.kind).toBe("bind");
    if (r1.kind === "bind" && r2.kind === "bind") {
      expect(r1.payloadHash).not.toBe(r2.payloadHash);
    }
  });
});

// =====================================================================
// decideBlueskyPublishGate — BLOCK on stale hash
// =====================================================================

describe("decideBlueskyPublishGate — publish-time enforcement", () => {
  it("rawIntent=null → proceed (legacy row)", async () => {
    const r = await decideBlueskyPublishGate({
      rawIntent: null,
      title: null,
      body: "hello",
      creative: null,
    });
    expect(r.kind).toBe("proceed");
  });

  it("intent set but no operatorApprovedShapeHash → proceed (MCP-prepared, not approved)", async () => {
    const r = await decideBlueskyPublishGate({
      rawIntent: rawIntent({ threadMode: "auto_thread_allowed" }),
      title: null,
      body: "hello",
      creative: null,
    });
    expect(r.kind).toBe("proceed");
  });

  it("matching hash → proceed", async () => {
    const intent = rawIntent({ threadMode: "auto_thread_allowed" });
    // Compute the hash the operator approval would have bound.
    const preview = blueskyAdapter.buildPreview({
      title: null,
      body: "stable body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape: {
        ...legacyPlatformNativeShape("bluesky"),
        intent: "new_post",
        threadMode: "auto_thread_allowed",
        mediaMode: "none",
      },
    });
    const hash = await computeProviderPayloadHash(preview);
    const boundIntent = { ...intent, operatorApprovedShapeHash: hash };

    const r = await decideBlueskyPublishGate({
      rawIntent: boundIntent,
      title: null,
      body: "stable body",
      creative: null,
    });
    expect(r.kind).toBe("proceed");
    if (r.kind === "proceed") {
      expect(r.payloadHash).toBe(hash);
    }
  });

  it("body change after approval → block_stale", async () => {
    const shape: PlatformNativeShape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post",
      threadMode: "auto_thread_allowed",
      mediaMode: "none",
    };
    const approvedPreview = blueskyAdapter.buildPreview({
      title: null,
      body: "original body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape,
    });
    const approvedHash = await computeProviderPayloadHash(approvedPreview);
    const intent = {
      ...rawIntent({ threadMode: "auto_thread_allowed" }),
      operatorApprovedShapeHash: approvedHash,
    };

    const r = await decideBlueskyPublishGate({
      rawIntent: intent,
      title: null,
      body: "edited body",
      creative: null,
    });
    expect(r.kind).toBe("block_stale");
    if (r.kind === "block_stale") {
      expect(r.approvedHash).toBe(approvedHash);
      expect(r.currentHash).not.toBe(approvedHash);
      expect(r.reasonDetail).toMatch(/operator-approved/i);
    }
  });

  it("creative change after approval → block_stale", async () => {
    const shape: PlatformNativeShape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post",
      threadMode: "auto_thread_allowed",
      mediaMode: "first_part_only",
    };
    const approvedPreview = blueskyAdapter.buildPreview({
      title: null,
      body: "stable body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: {
        assetUrl: "https://example.com/a.jpg",
        sourceUrl: null,
        altText: "alt A",
        creativeType: "image",
      },
      shape,
    });
    const approvedHash = await computeProviderPayloadHash(approvedPreview);
    const intent = {
      ...rawIntent({ threadMode: "auto_thread_allowed", mediaMode: "first_part_only" }),
      operatorApprovedShapeHash: approvedHash,
    };

    const r = await decideBlueskyPublishGate({
      rawIntent: intent,
      title: null,
      body: "stable body",
      creative: {
        assetUrl: "https://example.com/b.jpg",
        sourceUrl: null,
        altText: "alt B",
        creativeType: "image",
      },
    });
    expect(r.kind).toBe("block_stale");
  });
});
