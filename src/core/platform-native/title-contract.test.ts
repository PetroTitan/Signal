import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { requiresTitle, titleRequirementBlocker } from "./approval-policy";
import { listPlatformAdapters } from "./adapters/registry";
import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";

/**
 * The title contract.
 *
 * Three publishers refuse to publish without a title, unconditionally:
 *
 *   publish-reddit.ts    → "missing_title"
 *   publish-devto.ts     → "article_title_required"
 *   publish-hashnode.ts  → "hashnode_title_required"
 *
 * Everything else is body-only — X, Bluesky, Telegram, Threads, and an
 * Instagram caption never read `request.title` at all. The predicate
 * exists so that fact lives in one place instead of being re-derived,
 * or forgotten, at each of the six gates that used to enforce a
 * universal rule.
 *
 * These tests pin the predicate in BOTH directions, and pin it against
 * the filesystem, so relaxing the UI can never quietly relax the
 * provider gate.
 */

const REPO_ROOT = process.cwd();

/** Platforms whose publisher refuses without a title. Kept as a literal
 *  because it is checked against the actual publisher sources below —
 *  the source is the authority, this is the claim being tested. */
const PUBLISHER_TITLE_GATES: ReadonlyArray<[string, string]> = [
  ["reddit", "missing_title"],
  ["devto", "article_title_required"],
  ["hashnode", "hashnode_title_required"],
];

describe("requiresTitle — destinations whose publisher demands one", () => {
  it.each(["reddit", "devto", "hashnode"])(
    "%s requires a title",
    (platform) => {
      expect(requiresTitle({ platform, contentType: "post" })).toBe(true);
    },
  );

  it("requires a title on legacy rows with no content type or intent", () => {
    // The three publisher gates are unconditional, so approving a
    // legacy row without a title would only move the failure into a
    // terminal publish failure the operator has to recover from.
    for (const [platform] of PUBLISHER_TITLE_GATES) {
      expect(
        requiresTitle({ platform, contentType: null, intent: null }),
        platform,
      ).toBe(true);
      expect(
        requiresTitle({ platform, contentType: null, intent: "unknown" }),
        platform,
      ).toBe(true);
    }
  });

  it("requires a title for a LinkedIn article but not a LinkedIn post", () => {
    expect(requiresTitle({ platform: "linkedin", contentType: "article" })).toBe(
      true,
    );
    expect(requiresTitle({ platform: "linkedin", contentType: "post" })).toBe(
      false,
    );
  });

  it("requires a title for a YouTube upload but not a community post", () => {
    expect(
      requiresTitle({ platform: "youtube", contentType: "video_post" }),
    ).toBe(true);
    expect(
      requiresTitle({ platform: "youtube", contentType: "short_video" }),
    ).toBe(true);
    expect(
      requiresTitle({ platform: "youtube", contentType: "community_post" }),
    ).toBe(false);
  });

  it("does not require a title for a Reddit comment or reply", () => {
    // Parent-anchored objects have no title field at all.
    expect(requiresTitle({ platform: "reddit", contentType: "comment" })).toBe(
      false,
    );
    expect(requiresTitle({ platform: "reddit", contentType: "reply" })).toBe(
      false,
    );
  });
});

describe("requiresTitle — platform-native social posts are titleless", () => {
  it.each(["x", "bluesky", "telegram", "threads", "instagram", "indie_hackers"])(
    "%s does not require a title",
    (platform) => {
      expect(requiresTitle({ platform, contentType: "post" })).toBe(false);
      expect(requiresTitle({ platform, contentType: null })).toBe(false);
      expect(requiresTitle({ platform, contentType: "thread" })).toBe(false);
    },
  );

  it("does not require a title before a destination is chosen", () => {
    expect(requiresTitle({ platform: null })).toBe(false);
    expect(requiresTitle({ platform: "  " })).toBe(false);
  });

  it("defaults to optional for an unrecognized platform", () => {
    // Adding a platform must not silently reinstate the universal rule.
    expect(requiresTitle({ platform: "myspace", contentType: "post" })).toBe(
      false,
    );
  });

  it("is case-insensitive on both platform and object", () => {
    expect(requiresTitle({ platform: "Reddit", contentType: "POST" })).toBe(
      true,
    );
    expect(requiresTitle({ platform: "DEVTO" })).toBe(true);
  });
});

describe("titleRequirementBlocker", () => {
  it("returns null when no title is required", () => {
    expect(
      titleRequirementBlocker({ platform: "x", contentType: "post", title: null }),
    ).toBeNull();
  });

  it("returns null when a required title is present", () => {
    expect(
      titleRequirementBlocker({
        platform: "devto",
        contentType: "article",
        title: "A real headline",
      }),
    ).toBeNull();
  });

  it("treats a whitespace-only title as missing", () => {
    expect(
      titleRequirementBlocker({
        platform: "devto",
        contentType: "article",
        title: "   ",
      }),
    ).not.toBeNull();
  });

  it("names the destination so the operator knows why", () => {
    expect(
      titleRequirementBlocker({ platform: "hashnode", title: null }),
    ).toContain("Hashnode");
    expect(
      titleRequirementBlocker({ platform: "reddit", title: null }),
    ).toContain("Reddit");
  });
});

describe("the predicate agrees with the adapters and the publishers", () => {
  it("every adapter declaring requiresTitle has a required-title case", () => {
    // Adapter capability flags are declarative and (verified separately)
    // read by zero production files. They are still the platform-native
    // layer's stated truth, so the approval-time predicate must not
    // contradict them.
    for (const adapter of listPlatformAdapters()) {
      if (!adapter.capabilities.requiresTitle) continue;
      expect(
        requiresTitle({
          platform: adapter.capabilities.platform,
          contentType: "post",
        }),
        `${adapter.capabilities.platform} declares requiresTitle`,
      ).toBe(true);
    }
  });

  it("every platform the predicate requires is backed by a real publisher gate", () => {
    const required = FOUNDER_PLATFORMS.filter((p) =>
      requiresTitle({ platform: p, contentType: "post" }),
    );
    // LinkedIn/YouTube are article/upload-only requirements and are not
    // required for a plain "post", so this set is exactly the three
    // publishers that refuse.
    expect(required.sort()).toEqual(["devto", "hashnode", "reddit"]);
  });

  it("the publishers still refuse without a title (filesystem-pinned)", () => {
    // Relaxing the UI must never relax the provider gate. Scanning the
    // source rather than trusting a constant means deleting the gate
    // fails here even if every unit test still passes.
    for (const [platform, reasonCode] of PUBLISHER_TITLE_GATES) {
      const file = path.join(
        REPO_ROOT,
        "src",
        "core",
        "publishing",
        `publish-${platform}.ts`,
      );
      const source = fs.readFileSync(file, "utf8");
      expect(source, `${platform} publisher`).toContain(reasonCode);
      expect(source, `${platform} publisher title guard`).toMatch(
        /request\.title[\s\S]{0,80}trim\(\)\.length === 0/,
      );
    }
  });

  it("Bluesky's tier-one publish path no longer demands a title", () => {
    // The tier-one action gated all three of dev.to / Hashnode /
    // Bluesky on a title, although the Bluesky adapter declares
    // requiresTitle:false and its publisher never reads the field.
    const source = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "src",
        "app",
        "(app)",
        "execution",
        "items",
        "[id]",
        "_publish-tier-one-action.ts",
      ),
      "utf8",
    );
    expect(source).toContain("titleRequirementBlocker");
    expect(source).not.toContain("This post needs a title before publishing.");
    expect(requiresTitle({ platform: "bluesky", contentType: null })).toBe(
      false,
    );
  });
});
