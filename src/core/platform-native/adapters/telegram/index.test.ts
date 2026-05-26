import { describe, expect, it } from "vitest";
import { telegramAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: null,
    body: "hello channel",
    identity: { displayName: null, handle: "@my-channel", avatarUrl: null },
    creative: null,
    shape: { ...legacyPlatformNativeShape("telegram"), intent: "new_post" },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return {
    ...legacyPlatformNativeShape("telegram"),
    intent: "new_post",
    ...over,
  };
}

describe("telegramAdapter — capabilities", () => {
  it("new_post + media_post + unknown", () => {
    const c = telegramAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("new_post")).toBe(true);
    expect(c.supportedIntents.has("media_post")).toBe(true);
    expect(c.requiresTarget).toBe(true);
    expect(c.budgets.perPartBudget).toBe(4096);
  });
});

describe("telegramAdapter — target", () => {
  it("target via input.target → routing.chat_target", () => {
    const p = telegramAdapter.buildPreview(
      input({ target: "@override", identity: { displayName: null, handle: null, avatarUrl: null } }),
    );
    expect(p.routing?.chat_target).toBe("@override");
  });

  it("target falls back to identity.handle when input.target missing", () => {
    const p = telegramAdapter.buildPreview(input());
    expect(p.routing?.chat_target).toBe("@my-channel");
  });

  it("no target anywhere → telegram_target_required", () => {
    const p = telegramAdapter.buildPreview(
      input({
        target: "",
        identity: { displayName: null, handle: null, avatarUrl: null },
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("telegram_target_required");
  });
});

describe("telegramAdapter — text message", () => {
  it("happy path", () => {
    const p = telegramAdapter.buildPreview(input());
    expect(p.format).toBe("single_post");
    expect(p.blockers).toEqual([]);
  });

  it("body > 4096 → telegram_message_exceeds_budget (NO silent clip)", () => {
    const p = telegramAdapter.buildPreview(
      input({ body: "x".repeat(4100) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "telegram_message_exceeds_budget",
    );
    // Spec: NO silent clipping.
    expect(p.parts[0].text.length).toBe(4100);
  });

  it("empty body → empty_body", () => {
    const p = telegramAdapter.buildPreview(input({ body: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("empty_body");
  });
});

describe("telegramAdapter — media_message", () => {
  it("media_post without creative → media_required_for_media_post", () => {
    const p = telegramAdapter.buildPreview(
      input({ shape: shape({ intent: "media_post" }) }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "media_required_for_media_post",
    );
  });

  it("caption > 1024 chars → telegram_caption_exceeds_budget", () => {
    const p = telegramAdapter.buildPreview(
      input({
        body: "x".repeat(1100),
        shape: shape({ intent: "media_post" }),
        creative: {
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: "alt",
          creativeType: "image",
        },
      }),
    );
    expect(p.blockers.map((b) => b.code)).toContain(
      "telegram_caption_exceeds_budget",
    );
  });
});
