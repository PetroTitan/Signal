import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  AUTHENTICATED_ROUTES,
  NON_NAVIGABLE_ROUTES,
  PRIMARY_ROUTES,
  SECONDARY_ROUTES,
  SETTINGS_ROUTES,
  visibleTo,
  type RouteEntry,
} from "@/core/navigation/route-manifest";
import { can } from "@/core/teams/permissions";

const REPO_ROOT = process.cwd();
const APP_DIR = path.join(REPO_ROOT, "src", "app", "(app)");

/**
 * Orphaned-route guard.
 *
 * The milestone's root defect was not "MCP is missing a link" — it was
 * that nothing in the codebase could answer "is this route reachable?".
 * Navigation lived in two hand-maintained arrays that no test compared
 * to the route tree, so `/settings/mcp`, `/notifications` and
 * `/backlog` drifted out of reach without anything failing.
 *
 * This walks the actual App Router tree and requires every page to be
 * classified. "contextual" and "internal" are perfectly good answers —
 * the point is that they must be CHOSEN, and choosing them requires
 * saying where the route is reached from.
 */

/** Every `page.tsx` under src/app/(app)/, as a route pattern. */
function routesFromFilesystem(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Route groups like (app) do not contribute a path segment.
      const segment = /^\(.*\)$/.test(entry.name) ? "" : `/${entry.name}`;
      out.push(...routesFromFilesystem(path.join(dir, entry.name), prefix + segment));
    } else if (entry.name === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

const FILESYSTEM_ROUTES = routesFromFilesystem(APP_DIR).sort();

describe("guard the guard", () => {
  it("found the authenticated route tree", () => {
    // A broken walk would make every assertion below pass vacuously.
    expect(FILESYSTEM_ROUTES.length).toBeGreaterThan(20);
    expect(FILESYSTEM_ROUTES).toContain("/settings/mcp");
    expect(FILESYSTEM_ROUTES).toContain("/dashboard");
  });
});

describe("every authenticated route is classified", () => {
  it("the manifest covers the route tree exactly — no orphans, no ghosts", () => {
    const manifest = AUTHENTICATED_ROUTES.map((r) => r.href).sort();

    const unclassified = FILESYSTEM_ROUTES.filter((r) => !manifest.includes(r));
    const ghosts = manifest.filter((r) => !FILESYSTEM_ROUTES.includes(r));

    const detail = [
      ...unclassified.map(
        (r) =>
          `${r} exists as a page but is not in route-manifest.ts. Add it with a ` +
          `tier — "contextual" or "internal" are valid answers, but the ` +
          `classification has to be deliberate or the route becomes invisible ` +
          `the way /settings/mcp did.`,
      ),
      ...ghosts.map(
        (r) => `${r} is in route-manifest.ts but has no page.tsx — stale entry.`,
      ),
    ].join("\n");

    expect(detail).toBe("");
  });

  it("lists each route exactly once", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of AUTHENTICATED_ROUTES) {
      if (seen.has(r.href)) dupes.push(r.href);
      seen.add(r.href);
    }
    expect(dupes).toEqual([]);
  });

  it("requires non-navigable routes to say where they ARE reached from", () => {
    // Otherwise "contextual" becomes a place to hide unfinished thinking.
    for (const r of NON_NAVIGABLE_ROUTES) {
      expect(r.reachableFrom, `${r.href} is contextual but says nothing about how it is reached`).toBeTruthy();
    }
  });

  it("marks every dynamic route as dynamic", () => {
    for (const r of AUTHENTICATED_ROUTES) {
      if (r.href.includes("[")) {
        expect(r.dynamic, `${r.href} has a dynamic segment`).toBe(true);
      }
    }
  });

  it("keeps dynamic routes out of every navigation surface", () => {
    for (const list of [PRIMARY_ROUTES, SECONDARY_ROUTES, SETTINGS_ROUTES]) {
      for (const r of list) {
        expect(r.dynamic ?? false, `${r.href} must not be in a nav surface`).toBe(
          false,
        );
      }
    }
  });
});

describe("the bottom bar stays simple", () => {
  it("has at most five primary destinations", () => {
    // A sixth would put every tab under ~53px at 320px. The More sheet
    // is where growth goes, not the bar.
    expect(PRIMARY_ROUTES.length).toBeLessThanOrEqual(5);
  });

  it("is exactly the daily loop", () => {
    expect(PRIMARY_ROUTES.map((r) => r.href)).toEqual([
      "/dashboard",
      "/weekly-plan",
      "/execution",
      "/accounts",
      "/products",
    ]);
  });
});

describe("MCP is classified as reachable", () => {
  it("is a settings route with a description and an admin permission", () => {
    const mcp = AUTHENTICATED_ROUTES.find((r) => r.href === "/settings/mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.tier).toBe("settings");
    expect(mcp!.description).toBeTruthy();
    // MCP tokens grant API access to the workspace.
    expect(mcp!.permission).toBe("manage_settings");
  });

  it("appears in the settings hub and the More sheet's source list", () => {
    expect(SETTINGS_ROUTES.map((r) => r.href)).toContain("/settings/mcp");
    expect(SECONDARY_ROUTES.map((r) => r.href)).toContain("/settings/mcp");
  });

  it("token management is classified too", () => {
    const tokens = AUTHENTICATED_ROUTES.find(
      (r) => r.href === "/settings/mcp/tokens",
    );
    expect(tokens?.tier).toBe("settings");
    expect(tokens?.permission).toBe("manage_settings");
  });
});

describe("the routes that were mobile-invisible are now classified", () => {
  it.each(["/notifications", "/backlog", "/library", "/results", "/activity", "/weekly-contracts"])(
    "%s is a secondary destination",
    (href) => {
      const entry = AUTHENTICATED_ROUTES.find((r) => r.href === href);
      expect(entry?.tier).toBe("secondary");
    },
  );
});

describe("role-aware visibility", () => {
  function hrefs(list: RouteEntry[]): string[] {
    return list.map((r) => r.href);
  }

  it("an owner sees every secondary destination", () => {
    expect(hrefs(visibleTo(SECONDARY_ROUTES, "owner", can))).toEqual(
      SECONDARY_ROUTES.map((r) => r.href),
    );
  });

  it("a viewer never sees MCP, team, or the operator bridge", () => {
    const seen = hrefs(visibleTo(SECONDARY_ROUTES, "viewer", can));
    expect(seen).not.toContain("/settings/mcp");
    expect(seen).not.toContain("/settings/mcp/tokens");
    expect(seen).not.toContain("/settings/team");
    expect(seen).not.toContain("/operator-bridge");
  });

  it("a viewer still sees the content surfaces", () => {
    const seen = hrefs(visibleTo(SECONDARY_ROUTES, "viewer", can));
    expect(seen).toContain("/library");
    expect(seen).toContain("/results");
    expect(seen).toContain("/settings");
  });

  it("an editor cannot manage settings but an admin can", () => {
    expect(hrefs(visibleTo(SECONDARY_ROUTES, "editor", can))).not.toContain(
      "/settings/mcp",
    );
    expect(hrefs(visibleTo(SECONDARY_ROUTES, "admin", can))).toContain(
      "/settings/mcp",
    );
  });

  it("a null role sees only ungated entries", () => {
    // Session still loading. Hide rather than flash-and-withdraw.
    const seen = hrefs(visibleTo(SECONDARY_ROUTES, null, can));
    expect(seen).not.toContain("/settings/mcp");
    expect(seen).toContain("/settings");
  });

  it("gates exactly the permissions the role model defines", () => {
    // Guards against inventing a permission string the model has no
    // concept of, which would silently hide an entry from everyone.
    for (const r of AUTHENTICATED_ROUTES) {
      if (!r.permission) continue;
      expect(can("owner", r.permission), `${r.href} → ${r.permission}`).toBe(
        true,
      );
    }
  });
});

// =====================================================================
// Coverage — every navigable route has at least one surface
// =====================================================================
//
// The sidebar keeps its own hand-authored order and icons on purpose:
// the desktop IA is a deliberate arrangement, and rewriting it would be
// churn this milestone does not need. What must not happen again is a
// manifest route with NO surface at all — which is how /settings/mcp,
// /notifications and /backlog became unreachable.

const SIDEBAR_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "src", "components", "sidebar.tsx"),
  "utf8",
);
const SETTINGS_PAGE_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "src", "app", "(app)", "settings", "page.tsx"),
  "utf8",
);

describe("every navigable route has a home", () => {
  it("the desktop sidebar covers the primary, secondary and internal tiers", () => {
    // Settings SUB-pages are deliberately absent from the sidebar — the
    // hub is their home — so they are excluded here.
    const expected = AUTHENTICATED_ROUTES.filter(
      (r) =>
        r.tier === "primary" || r.tier === "secondary" || r.tier === "internal",
    );
    const missing = expected
      .filter((r) => !SIDEBAR_SOURCE.includes(`"${r.href}"`))
      .map(
        (r) =>
          `${r.href} (${r.tier}) is navigable but absent from the desktop ` +
          `sidebar — desktop and mobile would disagree again.`,
      );
    expect(missing.join("\n")).toBe("");
  });

  it("the settings hub derives its list from the manifest", () => {
    // Asserting the derivation rather than each href: a hardcoded list
    // is exactly what omitted MCP.
    expect(SETTINGS_PAGE_SOURCE).toContain("SETTINGS_ROUTES");
    expect(SETTINGS_PAGE_SOURCE).toContain("visibleTo");
  });

  it("the mobile surfaces derive from the manifest too", () => {
    const nav = fs.readFileSync(
      path.join(REPO_ROOT, "src", "components", "mobile-nav.tsx"),
      "utf8",
    );
    const sheet = fs.readFileSync(
      path.join(REPO_ROOT, "src", "components", "mobile-more-sheet.tsx"),
      "utf8",
    );
    expect(nav).toContain("PRIMARY_ROUTES");
    expect(sheet).toContain("SECONDARY_ROUTES");
    // Neither may keep a literal route list of its own.
    expect(nav).not.toMatch(/href:\s*"\/dashboard"/);
    expect(sheet).not.toMatch(/href:\s*"\/settings/);
  });

  it("no settings route is reachable ONLY from the desktop sidebar", () => {
    // The exact shape of the MCP defect: present in the desktop-only
    // aside and nowhere else.
    for (const r of SETTINGS_ROUTES) {
      const inHub = SETTINGS_PAGE_SOURCE.includes("SETTINGS_ROUTES");
      expect(inHub, `${r.href} needs a non-sidebar home`).toBe(true);
    }
  });
});

describe("manifest quality", () => {
  it("every navigable entry has a label and a description", () => {
    for (const r of [...PRIMARY_ROUTES, ...SECONDARY_ROUTES]) {
      expect(r.label, r.href).toBeTruthy();
      expect(r.description, `${r.href} needs a one-line description`).toBeTruthy();
    }
  });

  it("uses Signal's existing terminology for the destinations it renames", () => {
    // These strings already exist in the product; the manifest must not
    // invent a second vocabulary for the same page.
    const byHref = new Map(AUTHENTICATED_ROUTES.map((r) => [r.href, r.label]));
    expect(byHref.get("/weekly-contracts")).toBe("Publishing scope");
    expect(byHref.get("/library")).toBe("Content library");
    expect(byHref.get("/execution")).toBe("Publishing");
  });
});
