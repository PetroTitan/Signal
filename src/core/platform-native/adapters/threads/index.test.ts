import { describe, expect, it } from "vitest";
import { threadsAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "Short threads post.",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: { ...legacyPlatformNativeShape("threads"), intent: "new_post" },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("threads"), intent: "new_post", ...over };
}

describe("threadsAdapter — capabilities", () => {
  it("new_post / thread / reply / media_post + reply target supported", () => {
    const c = threadsAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("thread")).toBe(true);
    expect(c.supportedIntents.has("reply")).toBe(true);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.budgets.perPartBudget).toBe(500);
    expect(c.reply.supported).toBe(true);
    expect(c.quote.supported).toBe(false);
  });
});

describe("threadsAdapter — single + thread", () => {
  it("short body → single_post", () => {
    const p = threadsAdapter.buildPreview(input());
    expect(p.format).toBe("single_post");
    expect(p.blockers).toEqual([]);
  });

  it("body > 500 + single_only → threads_post_exceeds_budget (NO silent split)", () => {
    const p = threadsAdapter.buildPreview(
      input({
        body: "x".repeat(600),
        shape: shape({ threadMode: "single_only" }),
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "threads_post_exceeds_budget",
    );
  });

  it("body > 500 + auto_thread_allowed → thread", () => {
    const p = threadsAdapter.buildPreview(
      input({
        body: "x".repeat(1500),
        shape: shape({ threadMode: "auto_thread_allowed" }),
      }),
    );
    expect(p.format).toBe("thread");
    expect(p.parts.length).toBeGreaterThan(1);
  });
});

describe("threadsAdapter — reply", () => {
  it("reply without target → reply_target_required", () => {
    const p = threadsAdapter.buildPreview(
      input({ shape: shape({ intent: "reply" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("reply_target_required");
  });

  it("reply with target → routing carries target", () => {
    const p = threadsAdapter.buildPreview(
      input({
        shape: shape({
          intent: "reply",
          replyTarget: { externalId: "abc", url: null },
        }),
      }),
    );
    expect(p.routing?.reply_to_post_id).toBe("abc");
  });
});

describe("threadsAdapter — media_post", () => {
  it("media_post without creative → media_required_for_media_post", () => {
    const p = threadsAdapter.buildPreview(
      input({ shape: shape({ intent: "media_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "media_required_for_media_post",
    );
  });
});
