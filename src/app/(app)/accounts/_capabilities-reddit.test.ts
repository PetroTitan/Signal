import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Reddit's capability row on /accounts.
 *
 * This row said "Manual-first" unconditionally. That was true during
 * Reddit's API-approval hold and was never revisited: platform-guidance
 * declares `publishingMode: "api"`, `publishToReddit` is a real
 * publisher, reddit is in SCHEDULER_AUTONOMOUS_PLATFORMS, and
 * /settings/publishing-platforms already said "Connected via OAuth".
 * Two pages in the same product disagreed about the same platform.
 *
 * The important half of this test is the SECOND half. The manual answer
 * is still the truthful one while REDDIT_OAUTH_STATUS holds the
 * workspace at API approval, so the fix must not simply delete the
 * manual copy — it must make it conditional on the real runtime state.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function renderPanel(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV, ...env };
  vi.resetModules();
  const mod = await import("./_capabilities-panel");
  return renderToStaticMarkup(
    createElement(mod.PublishingCapabilitiesPanel, {}),
  );
}

/** Remove comments so source assertions test code, not the prose that
 *  explains it — the panel's own comment quotes the string it removed. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Isolate the Reddit row from the eleven-row panel. */
function redditRow(html: string): string {
  const start = html.indexOf("Reddit");
  expect(start, "Reddit row not found in panel").toBeGreaterThan(-1);
  return html.slice(start, start + 400);
}

describe("Reddit capability row — OAuth available", () => {
  it("does not claim manual-first when the provider is configured", async () => {
    const html = await renderPanel({
      REDDIT_OAUTH_STATUS: "available",
      REDDIT_CLIENT_ID: "cid",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_REDIRECT_URI: "https://example.com/cb",
      TOKEN_ENCRYPTION_KEY: "k".repeat(64),
    });
    const row = redditRow(html);
    expect(row).not.toContain("Manual-first");
    expect(row).not.toContain("Manual mode");
    expect(row).toContain("Automated when connected");
  });

  it("reports setup needed when the provider env is missing", async () => {
    // Truthful degradation: OAuth is the path, but it is not usable
    // yet. It must NOT fall back to claiming manual publishing.
    const html = await renderPanel({
      REDDIT_OAUTH_STATUS: "available",
      REDDIT_CLIENT_ID: undefined,
      REDDIT_CLIENT_SECRET: undefined,
      TOKEN_ENCRYPTION_KEY: undefined,
    });
    const row = redditRow(html);
    expect(row).toContain("Setup needed");
    expect(row).not.toContain("Manual-first");
  });

  it("reports setup needed when token encryption is missing", async () => {
    const html = await renderPanel({
      REDDIT_OAUTH_STATUS: "available",
      REDDIT_CLIENT_ID: "cid",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_REDIRECT_URI: "https://example.com/cb",
      TOKEN_ENCRYPTION_KEY: undefined,
    });
    expect(redditRow(html)).toContain("Setup needed");
  });
});

describe("Reddit capability row — API-approval hold", () => {
  it("still tells the truth while the provider blocks it", async () => {
    // The conditional that must survive. Deleting the manual copy
    // outright would be its own lie.
    const html = await renderPanel({
      REDDIT_OAUTH_STATUS: "blocked_pending_reddit_api_approval",
      REDDIT_CLIENT_ID: "cid",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_REDIRECT_URI: "https://example.com/cb",
      TOKEN_ENCRYPTION_KEY: "k".repeat(64),
    });
    const row = redditRow(html);
    expect(row).toContain("Manual");
    expect(row).toContain("API approval pending");
  });

  it("the hold wins even when the OAuth env is fully configured", async () => {
    const html = await renderPanel({
      REDDIT_OAUTH_STATUS: "blocked_pending_reddit_api_approval",
      REDDIT_CLIENT_ID: "cid",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_REDIRECT_URI: "https://example.com/cb",
      TOKEN_ENCRYPTION_KEY: "k".repeat(64),
    });
    expect(redditRow(html)).not.toContain("Automated when connected");
  });
});

describe("the stale copy is gone from the source", () => {
  it("the panel no longer hardcodes Manual-first for Reddit", () => {
    const source = stripComments(
      fs.readFileSync(
        path.join(process.cwd(), "src", "app", "(app)", "accounts", "_capabilities-panel.tsx"),
        "utf8",
      ),
    );
    // The literal only ever existed on the Reddit branch.
    expect(source).not.toContain('"Manual-first"');
  });

  it("the panel derives Reddit readiness the same way the settings page does", () => {
    const panel = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "(app)", "accounts", "_capabilities-panel.tsx"),
      "utf8",
    );
    // Same AND as /settings/publishing-platforms: provider env plus
    // token encryption. Two pages disagreeing about one platform is
    // what this defect was.
    expect(panel).toContain('isOAuthProviderConfigured("reddit")');
    expect(panel).toContain("hasTokenEncryptionKey()");
  });

  it("platform-guidance's docstring no longer calls Reddit manual-first", () => {
    const guidance = fs.readFileSync(
      path.join(process.cwd(), "src", "core", "publishing", "platform-guidance.ts"),
      "utf8",
    );
    const header = guidance.slice(0, guidance.indexOf("export type FounderPlatform"));
    // Header IS the docstring here, so it is asserted un-stripped.
    expect(header).not.toMatch(/reddit\s+\(manual-first/);
    // X was described as manual-first distribution too, and has been
    // autonomous since F9.
    expect(header).not.toMatch(/x\s+\(F5\.0 — manual-first/);
  });
});
