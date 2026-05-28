import { describe, expect, it } from "vitest";
import {
  buildPublishingPlatformRows,
  type PublishingPlatformsInputs,
} from "./_rows";

/**
 * /settings/publishing-platforms — workspace-level row resolver
 * regression tests.
 *
 * Pre-fix this page hardcoded an inline rows array. Telegram was
 * missing entirely, and Reddit's "ready" branch only checked the
 * blocked flag — not the OAuth provider env or token encryption
 * key — so it could falsely claim "Connected via OAuth" in
 * deployments where the env wasn't fully wired.
 *
 * These tests pin the truthful row contract.
 */

function baseInputs(
  over: Partial<PublishingPlatformsInputs> = {},
): PublishingPlatformsInputs {
  return {
    tier1: {
      devto: { configured: false },
      hashnode: { configured: false, hasPublicationId: false },
      bluesky: { configured: false },
      telegram: { configured: false },
    },
    redditProviderConfigured: false,
    redditBlocked: false,
    xProviderConfigured: false,
    encryptionOn: false,
    ...over,
  };
}

function rowFor(
  inputs: PublishingPlatformsInputs,
  key: "reddit" | "x" | "devto" | "hashnode" | "bluesky" | "telegram",
) {
  const row = buildPublishingPlatformRows(inputs).find((r) => r.key === key);
  if (!row) throw new Error(`expected row ${key}`);
  return row;
}

// =====================================================================
// Row presence + ordering
// =====================================================================

describe("buildPublishingPlatformRows — presence", () => {
  it("returns rows for reddit, x, devto, hashnode, bluesky, telegram (6 in total)", () => {
    const rows = buildPublishingPlatformRows(baseInputs());
    expect(rows.map((r) => r.key)).toEqual([
      "reddit",
      "x",
      "devto",
      "hashnode",
      "bluesky",
      "telegram",
    ]);
  });

  it("Telegram is no longer hidden (regression: pre-fix the rows array omitted it)", () => {
    const rows = buildPublishingPlatformRows(baseInputs());
    const telegram = rows.find((r) => r.key === "telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.label).toBe("Telegram");
  });

  it("X is rendered as a row (Phase F9 — was hidden before X OAuth landed)", () => {
    const rows = buildPublishingPlatformRows(baseInputs());
    const x = rows.find((r) => r.key === "x");
    expect(x).toBeDefined();
    expect(x?.label).toBe("X");
  });
});

// =====================================================================
// X gating (Phase F9 — OAuth 2.0 with PKCE; no API-approval hold)
// =====================================================================

describe("X row — missing/ready branching", () => {
  it("missing X_CLIENT_ID/SECRET/REDIRECT_URI → missing (Setup needed)", () => {
    const row = rowFor(
      baseInputs({ xProviderConfigured: false, encryptionOn: true }),
      "x",
    );
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail).toContain("X_CLIENT_ID");
  });

  it("provider env set but TOKEN_ENCRYPTION_KEY missing → missing (token storage)", () => {
    const row = rowFor(
      baseInputs({ xProviderConfigured: true, encryptionOn: false }),
      "x",
    );
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail).toContain("TOKEN_ENCRYPTION_KEY");
  });

  it("provider env + encryption → ready ('Connect X through OAuth ...')", () => {
    const row = rowFor(
      baseInputs({ xProviderConfigured: true, encryptionOn: true }),
      "x",
    );
    expect(row.status.kind).toBe("ready");
    expect(row.status.detail).toContain("OAuth");
    expect(row.status.detail).toContain("approved post publishing");
  });
});

// =====================================================================
// Reddit gating
// =====================================================================

describe("Reddit row — ready/manual/missing branching", () => {
  it("provider + encryption + !blocked → ready ('Connected via OAuth.')", () => {
    const row = rowFor(
      baseInputs({
        redditProviderConfigured: true,
        encryptionOn: true,
        redditBlocked: false,
      }),
      "reddit",
    );
    expect(row.status.kind).toBe("ready");
    expect(row.status.detail).toBe("Connected via OAuth.");
  });

  it("blocked → manual (operator-facing copy explains the hold)", () => {
    const row = rowFor(
      baseInputs({
        redditProviderConfigured: true,
        encryptionOn: true,
        redditBlocked: true,
      }),
      "reddit",
    );
    expect(row.status.kind).toBe("manual");
    expect(row.status.detail.toLowerCase()).toContain("manual mode");
    expect(row.status.detail.toLowerCase()).toContain("api approval");
  });

  it("blocked takes precedence over missing env (manual, NOT missing)", () => {
    const row = rowFor(
      baseInputs({
        redditProviderConfigured: false,
        encryptionOn: false,
        redditBlocked: true,
      }),
      "reddit",
    );
    expect(row.status.kind).toBe("manual");
  });

  it("provider missing + !blocked → missing (NOT ready) — regression: pre-fix would have falsely shown 'Connected via OAuth.'", () => {
    const row = rowFor(
      baseInputs({
        redditProviderConfigured: false,
        encryptionOn: true,
        redditBlocked: false,
      }),
      "reddit",
    );
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail).toContain("REDDIT_CLIENT_ID");
  });

  it("provider configured but encryption off → missing (NOT ready)", () => {
    const row = rowFor(
      baseInputs({
        redditProviderConfigured: true,
        encryptionOn: false,
        redditBlocked: false,
      }),
      "reddit",
    );
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail).toContain("TOKEN_ENCRYPTION_KEY");
  });
});

// =====================================================================
// Telegram gating
// =====================================================================

describe("Telegram row — ready/missing branching", () => {
  it("bot token configured → ready with channel-admin reminder", () => {
    const row = rowFor(
      baseInputs({ tier1: { ...baseInputs().tier1, telegram: { configured: true } } }),
      "telegram",
    );
    expect(row.status.kind).toBe("ready");
    // Truthful detail: spell out the next operational requirement
    // (per-channel admin) so the row doesn't overclaim.
    expect(row.status.detail.toLowerCase()).toContain("bot token configured");
    expect(row.status.detail.toLowerCase()).toContain("admin");
    expect(row.status.detail.toLowerCase()).toContain("channel");
  });

  it("bot token NOT configured → missing", () => {
    const row = rowFor(baseInputs(), "telegram");
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("ready copy does NOT claim full automation — channel/admin requirement must be visible", () => {
    const row = rowFor(
      baseInputs({ tier1: { ...baseInputs().tier1, telegram: { configured: true } } }),
      "telegram",
    );
    // Negative assertion: ensure the detail is not the bare
    // "Connected." string that other rows use, because Telegram has
    // a per-channel precondition beyond the workspace token.
    expect(row.status.detail).not.toBe("Connected.");
  });
});

// =====================================================================
// Regression — other rows unchanged
// =====================================================================

describe("Bluesky row — unchanged behavior", () => {
  it("configured → ready ('Connected.')", () => {
    const row = rowFor(
      baseInputs({ tier1: { ...baseInputs().tier1, bluesky: { configured: true } } }),
      "bluesky",
    );
    expect(row.status.kind).toBe("ready");
    expect(row.status.detail).toBe("Connected.");
  });

  it("not configured → missing", () => {
    const row = rowFor(baseInputs(), "bluesky");
    expect(row.status.kind).toBe("missing");
  });
});

describe("dev.to row — unchanged behavior", () => {
  it("configured → ready", () => {
    const row = rowFor(
      baseInputs({ tier1: { ...baseInputs().tier1, devto: { configured: true } } }),
      "devto",
    );
    expect(row.status.kind).toBe("ready");
    expect(row.status.detail).toBe("Connected.");
  });
});

describe("Hashnode row — unchanged behavior", () => {
  it("API key configured → ready", () => {
    const row = rowFor(
      baseInputs({
        tier1: {
          ...baseInputs().tier1,
          hashnode: { configured: true, hasPublicationId: true },
        },
      }),
      "hashnode",
    );
    expect(row.status.kind).toBe("ready");
  });

  it("publication id set but no API key → missing (specific copy)", () => {
    const row = rowFor(
      baseInputs({
        tier1: {
          ...baseInputs().tier1,
          hashnode: { configured: false, hasPublicationId: true },
        },
      }),
      "hashnode",
    );
    expect(row.status.kind).toBe("missing");
    expect(row.status.detail.toLowerCase()).toContain("api key");
    expect(row.status.detail.toLowerCase()).toContain("publication");
  });

  it("neither configured → missing (generic copy)", () => {
    const row = rowFor(baseInputs(), "hashnode");
    expect(row.status.kind).toBe("missing");
  });
});
