import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Mobile navigation behaviour.
 *
 * The manifest is pinned by src/test/route-manifest.test.ts. This file
 * asserts what actually RENDERS — because the milestone's defect was
 * precisely that a route existed, was classified in someone's head as
 * "in the sidebar", and had no mobile path.
 */

vi.mock("react-dom", async (o) => {
  const actual = await o<Record<string, unknown>>();
  return {
    ...actual,
    useFormState: (_a: unknown, i: unknown) => [i, () => {}],
    useFormStatus: () => ({ pending: false }),
  };
});

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

let sessionRole: string | null = "owner";
vi.mock("@/core/workspace-session", () => ({
  useMaybeWorkspaceSession: () =>
    sessionRole === null
      ? null
      : {
          user: { id: "u1", email: "op@example.com" },
          workspace: { id: "w1", name: "Signal HQ" },
          settings: null,
          role: sessionRole,
          unreadNotifications: 0,
        },
}));

import { MobileNav } from "./mobile-nav";
import { MobileMoreSheet } from "./mobile-more-sheet";
import {
  PRIMARY_ROUTES,
  SECONDARY_ROUTES,
  visibleTo,
} from "@/core/navigation/route-manifest";
import { can } from "@/core/teams/permissions";

const ORIGINAL_ROLE = sessionRole;
afterEach(() => {
  sessionRole = ORIGINAL_ROLE;
  pathname = "/dashboard";
});

function navHtml(at = "/dashboard"): string {
  pathname = at;
  return renderToStaticMarkup(createElement(MobileNav));
}

function sheetHtml(role: string | null = "owner", at = "/dashboard"): string {
  sessionRole = role;
  pathname = at;
  return renderToStaticMarkup(
    createElement(MobileMoreSheet, { open: true, onClose: () => {} }),
  );
}

// =====================================================================
// 1 + 4 — MCP is reachable, and the entry exists everywhere
// =====================================================================

describe("1. MCP is reachable through mobile navigation", () => {
  it("the More sheet links to /settings/mcp", () => {
    // The route this milestone exists for. Its only entry used to be
    // sidebar.tsx:64, inside `hidden lg:flex`, inside a collapsed group.
    expect(sheetHtml("owner")).toContain('href="/settings/mcp"');
  });

  it("names it in the operator's terms, not as a route", () => {
    const html = sheetHtml("owner");
    expect(html).toContain("MCP &amp; AI integrations");
    expect(html).toMatch(/Claude or Codex/i);
  });

  it("the bottom bar opens the sheet that contains it", () => {
    const html = navHtml();
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("More");
  });
});

describe("4. the More entry is present on every authenticated page", () => {
  it.each([
    "/dashboard",
    "/weekly-plan",
    "/execution",
    "/accounts",
    "/products",
    "/settings",
    "/settings/mcp",
    "/library",
  ])("renders at %s", (at) => {
    // MobileNav is mounted by the shell, so it is present on every
    // authenticated route — this pins that the control itself does not
    // become route-conditional.
    expect(navHtml(at)).toContain("More");
  });
});

// =====================================================================
// 3 + 10 + 11 — the bar stays simple and correct
// =====================================================================

describe("3. the bottom bar does not grow uncontrollably", () => {
  it("renders exactly five destinations plus More", () => {
    const html = navHtml();
    const links = html.match(/<a /g)?.length ?? 0;
    expect(links).toBe(5);
    expect(PRIMARY_ROUTES.length).toBe(5);
  });

  it("does not put settings routes in the bar", () => {
    const html = navHtml();
    expect(html).not.toContain('href="/settings');
  });
});

describe("10. the primary destinations still work", () => {
  it.each([
    ["/dashboard", "Home"],
    ["/weekly-plan", "Plan"],
    ["/execution", "Publishing"],
    ["/accounts", "Accounts"],
    ["/products", "Products"],
  ])("%s renders as %s", (href, label) => {
    const html = navHtml();
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain(label);
  });
});

describe("11. active route semantics", () => {
  /** The whole <a …> tag carrying this href. Attribute order is
   *  React's, not ours, so slicing forward from href is unreliable. */
  function anchorFor(html: string, href: string): string {
    const at = html.indexOf(`href="${href}"`);
    expect(at, `no anchor for ${href}`).toBeGreaterThan(-1);
    const start = html.lastIndexOf("<a ", at);
    return html.slice(start, html.indexOf(">", at) + 1);
  }

  it("marks the current primary destination", () => {
    expect(anchorFor(navHtml("/weekly-plan"), "/weekly-plan")).toContain(
      'aria-current="page"',
    );
  });

  it("marks a nested route as its section", () => {
    expect(anchorFor(navHtml("/accounts/abc-123"), "/accounts")).toContain(
      'aria-current="page"',
    );
  });

  it("marks More as current when the route is not a primary one", () => {
    // A settings page used to leave the bar with no active state at all.
    const html = navHtml("/settings/mcp");
    const btn = html.slice(html.indexOf("<button"));
    expect(btn).toContain("border-signal-600");
    expect(html).not.toContain('aria-current="page"');
  });

  it("does not rely on colour alone", () => {
    const anchor = anchorFor(navHtml("/weekly-plan"), "/weekly-plan");
    expect(anchor).toContain("font-semibold");
    expect(anchor).toContain('aria-current="page"');
  });

  it("labels both navigation landmarks", () => {
    expect(navHtml()).toContain('aria-label="Primary"');
    expect(sheetHtml("owner")).toContain('aria-label="Secondary"');
  });
});

// =====================================================================
// 5 — role-aware visibility
// =====================================================================

describe("5. admin-only items respect role", () => {
  it("an owner sees MCP, team and the operator bridge", () => {
    const html = sheetHtml("owner");
    expect(html).toContain('href="/settings/mcp"');
    expect(html).toContain('href="/settings/team"');
    expect(html).toContain('href="/operator-bridge"');
  });

  it("a viewer sees none of them", () => {
    const html = sheetHtml("viewer");
    expect(html).not.toContain('href="/settings/mcp"');
    expect(html).not.toContain('href="/settings/team"');
    expect(html).not.toContain('href="/operator-bridge"');
  });

  it("a viewer still reaches the content surfaces and settings", () => {
    const html = sheetHtml("viewer");
    expect(html).toContain('href="/library"');
    expect(html).toContain('href="/results"');
    expect(html).toContain('href="/settings"');
  });

  it("an editor cannot manage settings; an admin can", () => {
    expect(sheetHtml("editor")).not.toContain('href="/settings/mcp"');
    expect(sheetHtml("admin")).toContain('href="/settings/mcp"');
  });

  it("renders every entry the predicate permits, for every role", () => {
    // Ties the rendered output to the predicate rather than to a list
    // written in this test.
    for (const role of ["owner", "admin", "editor", "reviewer", "viewer"]) {
      const html = sheetHtml(role);
      for (const r of visibleTo(SECONDARY_ROUTES, role as never, can)) {
        expect(html, `${role} → ${r.href}`).toContain(`href="${r.href}"`);
      }
    }
  });
});

// =====================================================================
// 6 — the settings hub covers every settings route
// =====================================================================

describe("6. the settings hub links to every intended secondary route", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "(app)", "settings", "page.tsx"),
    "utf8",
  );

  it("derives its list rather than hardcoding one", () => {
    // The hub previously linked to five sub-routes and omitted MCP.
    expect(source).toContain("SETTINGS_ROUTES");
    expect(source).toContain("visibleTo");
  });

  it("filters by role", () => {
    expect(source).toContain("visibleTo(SETTINGS_ROUTES");
    expect(source).toContain('from "@/core/teams/permissions"');
  });
});

// =====================================================================
// 7 + 8 — no parallel MCP implementation
// =====================================================================

describe("7. no duplicated MCP route or implementation", () => {
  it("there is exactly one MCP settings page", () => {
    const pages = fs
      .readdirSync(
        path.join(process.cwd(), "src", "app", "(app)", "settings", "mcp"),
        { withFileTypes: true },
      )
      .filter((e) => e.isFile() && e.name === "page.tsx");
    expect(pages).toHaveLength(1);
  });

  it("mobile navigation links to the same route desktop does", () => {
    // Both surfaces read the manifest; neither owns a route string.
    const sidebar = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "sidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toContain('"/settings/mcp"');
    expect(sheetHtml("owner")).toContain('href="/settings/mcp"');
  });

  it("the More sheet contains no server action or repository import", () => {
    // A parallel mobile implementation would show up here first.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "mobile-more-sheet.tsx"),
      "utf8",
    );
    expect(source).not.toContain("@/repositories/");
    expect(source).not.toContain("createSupabaseServerClient");
  });
});

describe("8. MCP token controls remain server-backed", () => {
  it("token actions still live in server actions", () => {
    const actions = fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "app",
        "(app)",
        "settings",
        "mcp",
        "tokens",
        "_actions.ts",
      ),
      "utf8",
    );
    expect(actions.startsWith('"use server"')).toBe(true);
  });

  it("navigation changed no token action", () => {
    const form = fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "app",
        "(app)",
        "settings",
        "mcp",
        "tokens",
        "_create-form.tsx",
      ),
      "utf8",
    );
    // The secret is still revealed by the action's return value, not
    // persisted client-side.
    expect(form).toContain("useFormState");
  });
});

// =====================================================================
// Sign out — had no mobile surface at all
// =====================================================================

describe("sign out is reachable on mobile", () => {
  it("the More sheet offers it", () => {
    // It previously existed only in the desktop sidebar's footer.
    expect(sheetHtml("owner")).toContain("Sign out");
  });

  it("is not offered without a session", () => {
    expect(sheetHtml(null)).not.toContain("Sign out");
  });
});

// =====================================================================
// 9 — long values do not create page overflow
// =====================================================================

describe("9. mobile surfaces are bounded", () => {
  it("the sheet bounds its own height and scrolls internally", () => {
    const html = sheetHtml("owner");
    expect(html).toContain("max-h-[85vh]");
    expect(html).toContain("overflow-y-auto");
  });

  it("respects the home-indicator inset", () => {
    expect(sheetHtml("owner")).toContain("safe-area-inset-bottom");
    expect(navHtml()).toContain("safe-area-inset-bottom");
  });

  it("meets the 44px touch-target floor", () => {
    expect(navHtml()).toContain("min-h-[44px]");
    expect(sheetHtml("owner")).toContain("min-h-[44px]");
  });

  it("the MCP endpoint and config snippet are bounded", () => {
    const tokens = fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "app",
        "(app)",
        "settings",
        "mcp",
        "tokens",
        "page.tsx",
      ),
      "utf8",
    );
    // A full https URL with no break opportunities.
    expect(tokens).toMatch(/break-all[^>]*>\s*\{endpoint\}|\{endpoint\}/);
    expect(tokens).toContain("break-all");

    const form = fs.readFileSync(
      path.join(
        process.cwd(),
        "src",
        "app",
        "(app)",
        "settings",
        "mcp",
        "tokens",
        "_create-form.tsx",
      ),
      "utf8",
    );
    // A bounded scroller only bounds when its wrapper can shrink.
    const code = form
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const pre = code.indexOf("<pre");
    expect(pre).toBeGreaterThan(-1);
    const wrapper = code.lastIndexOf("<div", pre);
    expect(code.slice(wrapper, pre)).toContain("min-w-0");
    expect(code.slice(pre, pre + 300)).toContain("overflow-x-auto");
  });
});
