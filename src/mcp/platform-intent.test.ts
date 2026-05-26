import { describe, expect, it } from "vitest";
import {
  buildShapeForCreate,
  buildShapeForUpdate,
  hasAnyPlatformIntentField,
  parsePlatformIntentFields,
  serializeMcpResponse,
  shouldClearApprovedHash,
  type McpPlatformIntentInput,
} from "./platform-intent";

// =====================================================================
// hasAnyPlatformIntentField
// =====================================================================

describe("hasAnyPlatformIntentField", () => {
  it("empty input → false (legacy mode)", () => {
    expect(hasAnyPlatformIntentField({})).toBe(false);
  });

  it("intent defined → true", () => {
    expect(hasAnyPlatformIntentField({ intent: "new_post" })).toBe(true);
  });

  it("explicit null counts as supplied (operator wants to clear)", () => {
    expect(hasAnyPlatformIntentField({ reply_to_url: null })).toBe(true);
  });

  it("expected_part_count alone counts", () => {
    expect(hasAnyPlatformIntentField({ expected_part_count: 3 })).toBe(true);
  });
});

// =====================================================================
// parsePlatformIntentFields
// =====================================================================

describe("parsePlatformIntentFields — strict validation", () => {
  it("empty object → ok with empty input", () => {
    const r = parsePlatformIntentFields({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  it("forbids operator_approved_shape_hash", () => {
    const r = parsePlatformIntentFields({
      operator_approved_shape_hash: "sha256:v1:abc",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("operator_approved_shape_hash_forbidden");
  });

  it("rejects unknown intent", () => {
    const r = parsePlatformIntentFields({ intent: "__future__" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("intent_invalid");
  });

  it("rejects unknown thread_mode / media_mode", () => {
    const r = parsePlatformIntentFields({
      thread_mode: "weird",
      media_mode: "weird",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("thread_mode_invalid");
      expect(r.errors).toContain("media_mode_invalid");
    }
  });

  it("rejects non-integer expected_part_count", () => {
    expect(parsePlatformIntentFields({ expected_part_count: 1.5 }).ok).toBe(false);
    expect(parsePlatformIntentFields({ expected_part_count: 0 }).ok).toBe(false);
    expect(parsePlatformIntentFields({ expected_part_count: -3 }).ok).toBe(false);
    expect(parsePlatformIntentFields({ expected_part_count: "3" }).ok).toBe(false);
  });

  it("accepts a fully-populated valid input", () => {
    const r = parsePlatformIntentFields({
      intent: "thread",
      thread_mode: "auto_thread_allowed",
      media_mode: "first_part_only",
      reply_to_url: null,
      reply_to_external_id: null,
      quote_url: "https://x.com/u/status/1",
      quote_external_id: "1",
      single_post_only: false,
      expected_part_count: 3,
    });
    expect(r.ok).toBe(true);
  });
});

// =====================================================================
// buildShapeForCreate
// =====================================================================

describe("buildShapeForCreate — legacy passthrough", () => {
  it("no native fields → mode=legacy, no serialized envelope", () => {
    const r = buildShapeForCreate({ platform: "bluesky", input: {} });
    expect(r.mode).toBe("legacy");
    expect(r.shape).toBeNull();
    expect(r.serialized).toBeNull();
    expect(r.blockers).toEqual([]);
  });
});

describe("buildShapeForCreate — explicit mode", () => {
  it("single_post_only=true forces thread_mode=single_only", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: { intent: "new_post", single_post_only: true },
    });
    expect(r.mode).toBe("explicit");
    expect(r.shape?.threadMode).toBe("single_only");
    expect(r.shape?.intent).toBe("new_post");
  });

  it("intent missing + other native field → defaults to new_post", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: { thread_mode: "single_only", media_mode: "first_part_only" },
    });
    expect(r.mode).toBe("explicit");
    expect(r.shape?.intent).toBe("new_post");
    expect(r.shape?.threadMode).toBe("single_only");
    expect(r.shape?.mediaMode).toBe("first_part_only");
  });

  it("Bluesky + intent=thread + auto_thread_allowed → valid", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: {
        intent: "thread",
        thread_mode: "auto_thread_allowed",
        expected_part_count: 4,
      },
    });
    expect(r.mode).toBe("explicit");
    expect(r.blockers).toEqual([]);
    expect(r.shape?.intent).toBe("thread");
    expect(r.shape?.expectedPartCount).toBe(4);
  });

  it("Bluesky + reply intent (currently unsupported in foundation) → blocker", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: { intent: "reply" },
    });
    expect(r.blockers.map((b) => b.code)).toContain("intent_not_supported");
  });

  it("X (now a real adapter) + intent=new_post → bind, no adapter_not_implemented", () => {
    // Phase F6.3: X moved from stub to real. This test pins that
    // the MCP layer no longer surfaces adapter_not_implemented for
    // a platform whose adapter ships.
    const r = buildShapeForCreate({
      platform: "x",
      input: { intent: "new_post" },
    });
    expect(r.mode).toBe("explicit");
    expect(r.blockers.map((b) => b.code)).not.toContain("adapter_not_implemented");
  });
});

describe("buildShapeForCreate — cross-field validation", () => {
  it("quote_url without intent=quote → quote_requires_quote_intent", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: { intent: "new_post", quote_url: "https://x.com/u/p/1" },
    });
    expect(r.blockers.map((b) => b.code)).toContain(
      "quote_requires_quote_intent",
    );
  });

  it("reply_to_url without intent=reply → reply_requires_reply_intent", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: {
        intent: "new_post",
        reply_to_url: "https://bsky.app/profile/u/post/x",
      },
    });
    expect(r.blockers.map((b) => b.code)).toContain(
      "reply_requires_reply_intent",
    );
  });

  it("single_post_only=true + intent=thread → thread_mode_conflicts_with_intent", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: { intent: "thread", single_post_only: true },
    });
    expect(r.blockers.map((b) => b.code)).toContain(
      "thread_mode_conflicts_with_intent",
    );
  });

  it("thread intent + expected_part_count=1 → thread_part_count_invalid", () => {
    const r = buildShapeForCreate({
      platform: "bluesky",
      input: {
        intent: "thread",
        thread_mode: "auto_thread_allowed",
        expected_part_count: 1,
      },
    });
    expect(r.blockers.map((b) => b.code)).toContain(
      "thread_part_count_invalid",
    );
  });
});

describe("buildShapeForCreate — platform required", () => {
  it("native fields without platform → platform_required_for_intent", () => {
    const r = buildShapeForCreate({
      platform: null,
      input: { intent: "new_post" },
    });
    expect(r.blockers.map((b) => b.code)).toContain(
      "platform_required_for_intent",
    );
  });

  it("no native fields AND no platform → legacy (no blocker)", () => {
    const r = buildShapeForCreate({ platform: null, input: {} });
    expect(r.mode).toBe("legacy");
    expect(r.blockers).toEqual([]);
  });
});

// =====================================================================
// buildShapeForUpdate — merge semantics
// =====================================================================

describe("buildShapeForUpdate — preserves existing fields", () => {
  it("undefined field → existing value preserved", () => {
    const existing: Record<string, unknown> = {
      version: 1,
      platform: "bluesky",
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "first_part_only",
      expectedPartCount: 3,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:abc",
    };
    const r = buildShapeForUpdate({
      platform: "bluesky",
      existingRaw: existing,
      input: { media_mode: "none" }, // only media_mode supplied
      externalPayloadChanged: false,
    });
    expect(r.mode).toBe("explicit");
    expect(r.shape?.intent).toBe("thread");
    expect(r.shape?.threadMode).toBe("auto_thread_allowed");
    expect(r.shape?.expectedPartCount).toBe(3);
    expect(r.shape?.mediaMode).toBe("none");
  });

  it("any intent change → clears operatorApprovedShapeHash", () => {
    const existing: Record<string, unknown> = {
      version: 1,
      platform: "bluesky",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      expectedPartCount: null,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:abc",
    };
    const r = buildShapeForUpdate({
      platform: "bluesky",
      existingRaw: existing,
      input: { media_mode: "first_part_only" },
      externalPayloadChanged: false,
    });
    expect(r.shape?.operatorApprovedShapeHash).toBeNull();
  });

  it("explicit null for both reply fields → clears reply_target", () => {
    const existing: Record<string, unknown> = {
      version: 1,
      platform: "bluesky",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      expectedPartCount: null,
      replyTarget: { url: "https://x", externalId: "at://x" },
      quoteTarget: null,
      operatorApprovedShapeHash: null,
    };
    const r = buildShapeForUpdate({
      platform: "bluesky",
      existingRaw: existing,
      input: { reply_to_url: null, reply_to_external_id: null },
      externalPayloadChanged: false,
    });
    expect(r.shape?.replyTarget).toBeNull();
  });

  it("no native fields + no existing + no external payload change → legacy", () => {
    const r = buildShapeForUpdate({
      platform: "bluesky",
      existingRaw: null,
      input: {},
      externalPayloadChanged: false,
    });
    expect(r.mode).toBe("legacy");
  });

  it("no native fields + body change + existing intent → clears hash", () => {
    const existing: Record<string, unknown> = {
      version: 1,
      platform: "bluesky",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      expectedPartCount: null,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:abc",
    };
    const r = buildShapeForUpdate({
      platform: "bluesky",
      existingRaw: existing,
      input: {},
      externalPayloadChanged: true,
    });
    expect(r.shape?.operatorApprovedShapeHash).toBeNull();
    expect(r.serialized).not.toBeNull();
  });
});

// =====================================================================
// shouldClearApprovedHash
// =====================================================================

describe("shouldClearApprovedHash — payload-relevance predicate", () => {
  const baseProbe = {
    bodyChanged: false,
    titleChanged: false,
    platformChanged: false,
    accountChanged: false,
    creativeChanged: false,
    intentFieldsPresent: false,
  };

  it("nothing changed → false", () => {
    expect(shouldClearApprovedHash(baseProbe)).toBe(false);
  });

  it("each payload-relevant flag triggers true", () => {
    expect(shouldClearApprovedHash({ ...baseProbe, bodyChanged: true })).toBe(true);
    expect(shouldClearApprovedHash({ ...baseProbe, titleChanged: true })).toBe(true);
    expect(shouldClearApprovedHash({ ...baseProbe, platformChanged: true })).toBe(true);
    expect(shouldClearApprovedHash({ ...baseProbe, accountChanged: true })).toBe(true);
    expect(shouldClearApprovedHash({ ...baseProbe, creativeChanged: true })).toBe(true);
    expect(shouldClearApprovedHash({ ...baseProbe, intentFieldsPresent: true })).toBe(true);
  });
});

// =====================================================================
// serializeMcpResponse — wire shape
// =====================================================================

describe("serializeMcpResponse", () => {
  it("legacy mode → platform_native_mode='legacy' + warning", () => {
    const r = serializeMcpResponse({
      mode: "legacy",
      shape: null,
      serialized: null,
      warnings: [],
      blockers: [],
    });
    expect(r).toEqual({
      platform_native_mode: "legacy",
      warning: expect.stringContaining("Legacy"),
    });
  });

  it("explicit mode → carries platform_publish_intent + blockers + warnings", () => {
    const inputBuild = buildShapeForCreate({
      platform: "bluesky",
      input: { intent: "new_post", single_post_only: true } as McpPlatformIntentInput,
    });
    const r = serializeMcpResponse(inputBuild);
    expect(r.platform_native_mode).toBe("explicit");
    expect(r.platform_publish_intent).toBeDefined();
    expect(r.validation_warnings).toEqual([]);
    expect(r.validation_blockers).toEqual([]);
  });
});

// =====================================================================
// All adapters real — MCP perspective
// =====================================================================
//
// Phase F6.3 shipped real adapters for every platform; no stubs
// remain. These tests pin the post-F6.3 contract:
//   - empty input on any platform still → legacy mode
//   - explicit intent on any platform → validated against THAT
//     platform's capability matrix (no adapter_not_implemented)

describe("all adapters real — MCP perspective", () => {
  it("X: empty input → legacy mode (no native fields supplied)", () => {
    const r = buildShapeForCreate({ platform: "x", input: {} });
    expect(r.mode).toBe("legacy");
    expect(r.blockers).toEqual([]);
  });

  it("Reddit: explicit new_post → validated against Reddit capability matrix", () => {
    const r = buildShapeForCreate({
      platform: "reddit",
      input: { intent: "new_post" },
    });
    expect(r.mode).toBe("explicit");
    expect(r.blockers.map((b) => b.code)).not.toContain("adapter_not_implemented");
  });

  it("Instagram: explicit unsupported intent (new_post) → intent_not_supported, not adapter_not_implemented", () => {
    const r = buildShapeForCreate({
      platform: "instagram",
      input: { intent: "new_post" },
    });
    expect(r.blockers.map((b) => b.code)).toContain("intent_not_supported");
    expect(r.blockers.map((b) => b.code)).not.toContain(
      "adapter_not_implemented",
    );
  });
});
