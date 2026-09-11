import { describe, expect, it } from "vitest";
import {
  bareHandle,
  formatAccountName,
  formatHandle,
  formatIdentityLabel,
  HANDLE_UNAVAILABLE,
} from "./handle-display";
import { normalizeBlueskyHandle } from "@/core/identity-verifiers/bluesky-resolve";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("formatHandle — exactly one leading @, always", () => {
  it("adds the @ when the stored handle has none", () => {
    expect(formatHandle("webmasterid.bsky.social")).toBe("@webmasterid.bsky.social");
  });

  it("does not double the @ when the stored handle already has one", () => {
    // THE PRODUCTION DEFECT: growth_accounts.handle stores what the
    // operator typed, and they typed the @. The UI then wrote `@{handle}`.
    expect(formatHandle("@webmasterid.bsky.social")).toBe("@webmasterid.bsky.social");
    expect(formatHandle("@webmasterid.bsky.social")).not.toBe("@@webmasterid.bsky.social");
  });

  it("collapses MULTIPLE leading @ to one", () => {
    expect(formatHandle("@@webmasterid.bsky.social")).toBe("@webmasterid.bsky.social");
    expect(formatHandle("@@@@@name.bsky.social")).toBe("@name.bsky.social");
  });

  it("is idempotent, so a second formatting pass is harmless", () => {
    for (const input of [
      "name.bsky.social",
      "@name.bsky.social",
      "@@name.bsky.social",
      "  @name.bsky.social  ",
    ]) {
      const once = formatHandle(input);
      expect(formatHandle(once)).toBe(once);
      expect(formatHandle(formatHandle(once))).toBe(once);
    }
  });

  it("trims surrounding and interior-adjacent whitespace", () => {
    expect(formatHandle("  name.bsky.social ")).toBe("@name.bsky.social");
    expect(formatHandle(" @ name.bsky.social")).toBe("@name.bsky.social");
  });

  it("falls back rather than rendering a bare @ or an empty label", () => {
    expect(formatHandle(null)).toBe(HANDLE_UNAVAILABLE);
    expect(formatHandle(undefined)).toBe(HANDLE_UNAVAILABLE);
    expect(formatHandle("")).toBe(HANDLE_UNAVAILABLE);
    expect(formatHandle("   ")).toBe(HANDLE_UNAVAILABLE);
    expect(formatHandle("@")).toBe(HANDLE_UNAVAILABLE);
    expect(formatHandle("@@@")).toBe(HANDLE_UNAVAILABLE);
  });

  it("accepts a caller-supplied fallback", () => {
    expect(formatHandle(null, "unknown")).toBe("unknown");
  });

  it("keeps the provider's literal handle.invalid rather than hiding it", () => {
    // A real value the API returns. Suppressing it would hide that the
    // account's handle could not be verified.
    expect(formatHandle("handle.invalid")).toBe("@handle.invalid");
  });

  it("preserves casing — a handle is case-insensitive and lowercasing misleads", () => {
    expect(formatHandle("@WebmasterID.bsky.social")).toBe("@WebmasterID.bsky.social");
  });

  it("does not mutate the caller's value", () => {
    const stored = "@@name.bsky.social";
    formatHandle(stored);
    expect(stored).toBe("@@name.bsky.social");
  });
});

describe("why normalizeBlueskyHandle could not be reused for display", () => {
  it("it strips only ONE @, so it leaves the defect in place", () => {
    // This is the reason handle-display.ts exists as a separate module
    // rather than a call to the existing normalizer.
    expect(normalizeBlueskyHandle("@@webmasterid.bsky.social")).toBe(
      "@webmasterid.bsky.social",
    );
    expect(bareHandle("@@webmasterid.bsky.social")).toBe("webmasterid.bsky.social");
  });

  it("it lowercases, which is right for an API call and wrong for a label", () => {
    expect(normalizeBlueskyHandle("@WebmasterID.bsky.social")).toBe(
      "webmasterid.bsky.social",
    );
    expect(bareHandle("@WebmasterID.bsky.social")).toBe("WebmasterID.bsky.social");
  });
});

describe("bareHandle", () => {
  it("returns the handle with no @ at all, for building a URL or an aria-label", () => {
    expect(bareHandle("@name.bsky.social")).toBe("name.bsky.social");
    expect(bareHandle("@@name.bsky.social")).toBe("name.bsky.social");
    expect(bareHandle("name.bsky.social")).toBe("name.bsky.social");
  });

  it("returns null for nothing usable", () => {
    expect(bareHandle(null)).toBeNull();
    expect(bareHandle("@")).toBeNull();
    expect(bareHandle("  ")).toBeNull();
  });
});

describe("formatIdentityLabel", () => {
  it("prefers the handle", () => {
    expect(
      formatIdentityLabel({ id: "a", handle: "@x.bsky.social", displayName: "X" }),
    ).toBe("@x.bsky.social");
  });

  it("falls back to the display name, then to the id", () => {
    expect(formatIdentityLabel({ id: "a", handle: null, displayName: "X" })).toBe("X");
    expect(formatIdentityLabel({ id: "a", handle: "@", displayName: "  " })).toBe("a");
  });

  it("never returns an empty string, which would render a blank option", () => {
    for (const identity of [
      { id: "a", handle: null, displayName: null },
      { id: "a", handle: "", displayName: "" },
      { id: "a", handle: "@@", displayName: "   " },
    ]) {
      expect(formatIdentityLabel(identity).length).toBeGreaterThan(0);
    }
  });
});

describe("formatAccountName", () => {
  it("prefers the display name, then the bare handle", () => {
    expect(formatAccountName({ displayName: "Real Name", handle: "@x" })).toBe(
      "Real Name",
    );
    expect(formatAccountName({ displayName: null, handle: "@x.bsky.social" })).toBe(
      "x.bsky.social",
    );
  });

  it("never falls back to a DID, which reads as noise in a heading", () => {
    const name = formatAccountName({ displayName: null, handle: null });
    expect(name).toBe("Bluesky account");
    expect(name).not.toMatch(/^did:/);
  });
});

describe("the defect cannot come back", () => {
  /** Strip comments so a control never fires on prose describing it. */
  const code = (t: string) =>
    t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  const SURFACES = [
    "src/app/(app)/relationships/_relationship-ui.tsx",
    "src/app/(app)/relationships/_actions.ts",
  ];

  it("no relationship surface concatenates a decorative @ onto a handle", () => {
    // `@{handle}` in JSX and `` `@${handle}` `` in a template are the
    // two spellings that produced "@@webmasterid.bsky.social". Break by
    // writing either and this fails, naming the file.
    for (const file of SURFACES) {
      const body = code(readFileSync(path.join(process.cwd(), file), "utf8"));
      expect(body, `${file} renders @{...} directly`).not.toMatch(/@\{/);
      expect(body, `${file} builds \`@\${...}\``).not.toMatch(/`[^`]*@\$\{/);
    }
  });

  it("the UI imports the formatter rather than rolling its own", () => {
    const ui = readFileSync(
      path.join(process.cwd(), "src/app/(app)/relationships/_relationship-ui.tsx"),
      "utf8",
    );
    expect(ui).toContain("@/core/bluesky-relationships/handle-display");
    // Every place a handle reaches the screen goes through one of these.
    for (const fn of ["formatHandle", "formatIdentityLabel", "formatAccountName"]) {
      expect(ui, `UI should use ${fn}`).toContain(fn);
    }
  });

  it("the formatter is client-safe — no server-only import anywhere in its chain", () => {
    // It is imported by a "use client" component; a `server-only`
    // import would break the build at runtime, not at test time.
    // Comments stripped: this module's own doc comment mentions
    // `server-only` while explaining that it carries none.
    const src = code(
      readFileSync(
        path.join(process.cwd(), "src/core/bluesky-relationships/handle-display.ts"),
        "utf8",
      ),
    );
    expect(src).not.toContain("server-only");
    expect(src).not.toMatch(/^import /m);
  });
});
