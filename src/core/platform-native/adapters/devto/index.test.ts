import { describe, expect, it } from "vitest";
import { devtoAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: "An article",
    body: "Markdown **body**.",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: { ...legacyPlatformNativeShape("devto"), intent: "article" },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("devto"), intent: "article", ...over };
}

describe("devtoAdapter — capabilities", () => {
  it("supports article + unknown only", () => {
    const c = devtoAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("article")).toBe(true);
    expect(c.supportedIntents.has("unknown")).toBe(true);
    expect(c.supportedIntents.has("new_post")).toBe(false);
    expect(c.requiresTitle).toBe(true);
  });
});

describe("devtoAdapter — article validation", () => {
  it("happy path: title + body → format=article, no blockers", () => {
    const p = devtoAdapter.buildPreview(input());
    expect(p.format).toBe("article");
    expect(p.blockers).toEqual([]);
    expect(p.routing?.article_title).toBe("An article");
  });

  it("missing title → article_title_required", () => {
    const p = devtoAdapter.buildPreview(input({ title: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("article_title_required");
  });

  it("title > 128 chars → devto_title_exceeds_budget", () => {
    const p = devtoAdapter.buildPreview(input({ title: "x".repeat(130) }));
    expect(p.blockers.map((b) => b.code)).toContain("devto_title_exceeds_budget");
  });

  it("missing body → article_body_required", () => {
    const p = devtoAdapter.buildPreview(input({ body: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("article_body_required");
  });

  it("preserves markdown verbatim (not stripped)", () => {
    const p = devtoAdapter.buildPreview(
      input({ body: "## Heading\n**bold** body" }),
    );
    // Articles publish markdown directly; the body part keeps it.
    expect(p.parts[0].text).toContain("## Heading");
    expect(p.parts[0].text).toContain("**bold**");
  });
});

describe("devtoAdapter — tags", () => {
  it("valid tags → routing.tags_csv populated", () => {
    const p = devtoAdapter.buildPreview(
      input({ tags: ["webdev", "typescript", "ai"] }),
    );
    expect(p.routing?.tags_csv).toBe("webdev,typescript,ai");
  });

  it("invalid tag format → devto_tag_format_invalid", () => {
    const p = devtoAdapter.buildPreview(
      input({ tags: ["valid-tag", "BAD TAG!"] }),
    );
    expect(p.blockers.map((b) => b.code)).toContain("devto_tag_format_invalid");
  });

  it(">4 tags → warning + first 4 retained", () => {
    const p = devtoAdapter.buildPreview(
      input({ tags: ["a", "b", "c", "d", "e", "f"] }),
    );
    expect(p.warnings.some((w) => /4/.test(w))).toBe(true);
    expect(p.routing?.tags_csv).toBe("a,b,c,d");
  });
});

describe("devtoAdapter — legacy shape", () => {
  it("legacy intent → format=unknown, no blockers", () => {
    const p = devtoAdapter.buildPreview(
      input({ shape: shape({ intent: "unknown" }) }),
    );
    expect(p.format).toBe("unknown");
    expect(p.blockers).toEqual([]);
  });
});
