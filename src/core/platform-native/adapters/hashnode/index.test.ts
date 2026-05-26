import { describe, expect, it } from "vitest";
import { hashnodeAdapter } from "./index";
import { legacyPlatformNativeShape, type PlatformNativeShape } from "../..";
import type { AdapterRenderInput } from "../types";

function input(over: Partial<AdapterRenderInput> = {}): AdapterRenderInput {
  return {
    title: "Hashnode article",
    body: "# Body\nbody text",
    identity: { displayName: null, handle: null, avatarUrl: null },
    creative: null,
    shape: { ...legacyPlatformNativeShape("hashnode"), intent: "article" },
    ...over,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return {
    ...legacyPlatformNativeShape("hashnode"),
    intent: "article",
    ...over,
  };
}

describe("hashnodeAdapter — capabilities", () => {
  it("article-only", () => {
    const c = hashnodeAdapter.capabilities;
    expect(c.stub).toBe(false);
    expect(c.supportedIntents.has("article")).toBe(true);
    expect(c.supportedIntents.has("new_post")).toBe(false);
    expect(c.requiresTitle).toBe(true);
  });
});

describe("hashnodeAdapter — article validation", () => {
  it("happy path", () => {
    const p = hashnodeAdapter.buildPreview(input());
    expect(p.format).toBe("article");
    expect(p.blockers).toEqual([]);
  });

  it("missing title → article_title_required", () => {
    const p = hashnodeAdapter.buildPreview(input({ title: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("article_title_required");
  });

  it("title > 250 → hashnode_title_exceeds_budget", () => {
    const p = hashnodeAdapter.buildPreview(input({ title: "x".repeat(260) }));
    expect(p.blockers.map((b) => b.code)).toContain(
      "hashnode_title_exceeds_budget",
    );
  });

  it("empty body → article_body_required", () => {
    const p = hashnodeAdapter.buildPreview(input({ body: "" }));
    expect(p.blockers.map((b) => b.code)).toContain("article_body_required");
  });

  it("preserves markdown verbatim", () => {
    const p = hashnodeAdapter.buildPreview(
      input({ body: "## Heading\n**bold**" }),
    );
    expect(p.parts[0].text).toContain("## Heading");
  });
});

describe("hashnodeAdapter — tags + slug source", () => {
  it("tags + title populate routing", () => {
    const p = hashnodeAdapter.buildPreview(
      input({ tags: ["react", "ts"] }),
    );
    expect(p.routing?.tags_csv).toBe("react,ts");
    expect(p.routing?.slug_source).toBe("Hashnode article");
  });

  it(">5 tags → warning + first 5 retained", () => {
    const p = hashnodeAdapter.buildPreview(
      input({ tags: ["a", "b", "c", "d", "e", "f"] }),
    );
    expect(p.routing?.tags_csv).toBe("a,b,c,d,e");
  });
});

describe("hashnodeAdapter — legacy", () => {
  it("legacy intent → format=unknown, no blockers", () => {
    const p = hashnodeAdapter.buildPreview(
      input({ shape: shape({ intent: "unknown" }) }),
    );
    expect(p.format).toBe("unknown");
    expect(p.blockers).toEqual([]);
  });
});
