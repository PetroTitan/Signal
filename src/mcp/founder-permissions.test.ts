import { describe, expect, it } from "vitest";
import {
  FOUNDER_PERMISSION_GROUPS,
  FOUNDER_PERMISSION_PRESETS,
  FULL_ACCESS_GROUP_KEY,
  describeScopesAsGroups,
  resolveScopesFromGroups,
  suggestGroupsForMissingScopes,
} from "./founder-permissions";
import { ALLOWED_SCOPES, BLOCKED_SCOPES } from "./permissions";
import { TOOLS_BY_NAME } from "./tool-registry";

/**
 * Pins the founder permission groups → scope mapping. The dispatcher
 * is the authority for what each tool requires; these tests confirm
 * that the UI groups actually produce the scopes those tools need.
 */

// =====================================================================
// Per-group scope mapping
// =====================================================================

describe("FOUNDER_PERMISSION_GROUPS — schedule_publishing", () => {
  it("exists with the load-bearing scopes for signal.schedule_publish", () => {
    const group = FOUNDER_PERMISSION_GROUPS.find(
      (g) => g.key === "schedule_publishing",
    );
    expect(group).toBeDefined();
    expect(group?.scopes).toContain("execution:schedule");
    expect(group?.scopes).toContain("execution:read");
    expect(group?.scopes).toContain("weekly_plans:read");
  });

  it("resolves to execution:schedule when checked alone", () => {
    expect(resolveScopesFromGroups(["schedule_publishing"])).toContain(
      "execution:schedule",
    );
  });

  it("is NOT default-checked (operators must opt in)", () => {
    const group = FOUNDER_PERMISSION_GROUPS.find(
      (g) => g.key === "schedule_publishing",
    );
    expect(group?.defaultChecked).toBe(false);
  });
});

describe("FOUNDER_PERMISSION_GROUPS — prepare_drafts (modify pending plan items)", () => {
  it("is labelled to reflect both create + update of pending items", () => {
    const group = FOUNDER_PERMISSION_GROUPS.find(
      (g) => g.key === "prepare_drafts",
    );
    expect(group?.label).toMatch(/pending|draft/i);
    expect(group?.scopes).toEqual(["weekly_plans:write_pending"]);
  });
});

describe("FOUNDER_PERMISSION_GROUPS — read execution diagnostics", () => {
  it("review_publishing_history grants execution:read (covers publish_history)", () => {
    const group = FOUNDER_PERMISSION_GROUPS.find(
      (g) => g.key === "review_publishing_history",
    );
    expect(group?.scopes).toContain("execution:read");
  });
});

describe("FOUNDER_PERMISSION_GROUPS — dry-run publishing checks", () => {
  it("dry_run_execution grants execution:dry_run", () => {
    const group = FOUNDER_PERMISSION_GROUPS.find(
      (g) => g.key === "dry_run_execution",
    );
    expect(group?.scopes).toContain("execution:dry_run");
  });
});

// =====================================================================
// Full access
// =====================================================================

describe("FULL_ACCESS_GROUP_KEY — sentinel expansion", () => {
  it("resolves to every entry in ALLOWED_SCOPES", () => {
    const scopes = resolveScopesFromGroups([FULL_ACCESS_GROUP_KEY]);
    expect(new Set(scopes)).toEqual(new Set(ALLOWED_SCOPES));
  });

  it("NEVER includes a BLOCKED_SCOPE even via full access", () => {
    const scopes = resolveScopesFromGroups([FULL_ACCESS_GROUP_KEY]);
    for (const blocked of BLOCKED_SCOPES) {
      expect(scopes).not.toContain(blocked);
    }
  });

  it("short-circuits other group keys (full access wins)", () => {
    // Add a nonsense key alongside; the sentinel still produces
    // the full set, no extras.
    const scopes = resolveScopesFromGroups([
      "read_workspace",
      FULL_ACCESS_GROUP_KEY,
      "bogus_key",
    ]);
    expect(new Set(scopes)).toEqual(new Set(ALLOWED_SCOPES));
  });

  it("absent → manual selection rules apply (no full expansion)", () => {
    const scopes = resolveScopesFromGroups(["read_workspace"]);
    expect(scopes).not.toContain("execution:schedule");
    expect(scopes).not.toContain("imports:prepare");
  });
});

// =====================================================================
// Presets
// =====================================================================

describe("FOUNDER_PERMISSION_PRESETS — codex_full_workflow", () => {
  const preset = FOUNDER_PERMISSION_PRESETS.find(
    (p) => p.key === "codex_full_workflow",
  );

  it("exists", () => {
    expect(preset).toBeDefined();
  });

  it("includes the groups required for signal.schedule_publish end-to-end", () => {
    const scopes = resolveScopesFromGroups(preset?.groupKeys ?? []);
    expect(scopes).toContain("execution:schedule");
    expect(scopes).toContain("weekly_plans:write_pending");
    expect(scopes).toContain("execution:read");
    expect(scopes).toContain("weekly_plans:read");
  });

  it("does not include full_access (preset uses individual groups)", () => {
    expect(preset?.groupKeys).not.toContain(FULL_ACCESS_GROUP_KEY);
  });
});

// =====================================================================
// Dispatcher-error suggestions
// =====================================================================

describe("suggestGroupsForMissingScopes", () => {
  it("missing execution:schedule → suggests 'Schedule publishing'", () => {
    const suggestions = suggestGroupsForMissingScopes(["execution:schedule"]);
    const labels = suggestions.map((g) => g.label);
    expect(labels).toContain("Schedule publishing");
  });

  it("missing weekly_plans:write_pending → suggests the prepare_drafts group", () => {
    const suggestions = suggestGroupsForMissingScopes([
      "weekly_plans:write_pending",
    ]);
    expect(suggestions.some((g) => g.key === "prepare_drafts")).toBe(true);
  });

  it("missing the two scopes signal.schedule_publish needs → suggests both groups", () => {
    const suggestions = suggestGroupsForMissingScopes([
      "weekly_plans:write_pending",
      "execution:schedule",
    ]);
    const keys = suggestions.map((g) => g.key);
    expect(keys).toContain("prepare_drafts");
    expect(keys).toContain("schedule_publishing");
  });

  it("returns groups in FOUNDER_PERMISSION_GROUPS order (deterministic)", () => {
    const suggestions = suggestGroupsForMissingScopes([
      "execution:schedule",
      "weekly_plans:write_pending",
    ]);
    const indices = suggestions.map((g) =>
      FOUNDER_PERMISSION_GROUPS.findIndex((og) => og.key === g.key),
    );
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("missing nothing → empty list", () => {
    expect(suggestGroupsForMissingScopes([])).toEqual([]);
  });

  it("missing unknown scope → empty list (no false matches)", () => {
    expect(
      suggestGroupsForMissingScopes(["nonsense:scope"]),
    ).toEqual([]);
  });
});

// =====================================================================
// Cross-check against the live tool registry
// =====================================================================

describe("end-to-end scheduled publishing — every required scope is reachable via UI", () => {
  it("signal.schedule_publish's required scopes are all granted by SOME existing group", () => {
    const tool = TOOLS_BY_NAME["signal.schedule_publish"];
    expect(tool).toBeDefined();
    for (const scope of tool!.requiredScopes) {
      const group = FOUNDER_PERMISSION_GROUPS.find((g) =>
        (g.scopes as ReadonlyArray<string>).includes(scope),
      );
      expect(group).toBeDefined();
    }
  });

  it("the codex_full_workflow preset covers every signal.schedule_publish scope", () => {
    const preset = FOUNDER_PERMISSION_PRESETS.find(
      (p) => p.key === "codex_full_workflow",
    )!;
    const presetScopes = new Set(resolveScopesFromGroups(preset.groupKeys));
    const tool = TOOLS_BY_NAME["signal.schedule_publish"]!;
    for (const required of tool.requiredScopes) {
      expect(presetScopes.has(required)).toBe(true);
    }
  });
});

// =====================================================================
// Backwards compat
// =====================================================================

describe("describeScopesAsGroups — existing tokens still label correctly", () => {
  it("a token minted with the old default checkboxes is still recognized", () => {
    // Pre-PR default scopes: read_workspace + prepare_drafts +
    // review_publishing_history.
    const oldDefaultScopes = resolveScopesFromGroups([
      "read_workspace",
      "prepare_drafts",
      "review_publishing_history",
    ]);
    const labels = describeScopesAsGroups(oldDefaultScopes);
    expect(labels).toContain("Read drafts and identities");
    expect(labels).toContain("Modify pending weekly plan items");
    expect(labels).toContain("Review publishing history");
  });

  it("a token with the new schedule_publishing scopes is described accordingly", () => {
    const scopes = resolveScopesFromGroups([
      "read_workspace",
      "prepare_drafts",
      "schedule_publishing",
    ]);
    const labels = describeScopesAsGroups(scopes);
    expect(labels).toContain("Schedule publishing");
  });

  it("a full-access token is described with every group label", () => {
    const scopes = resolveScopesFromGroups([FULL_ACCESS_GROUP_KEY]);
    const labels = describeScopesAsGroups(scopes);
    // Every group whose scopes are all present should be listed.
    for (const group of FOUNDER_PERMISSION_GROUPS) {
      expect(labels).toContain(group.label);
    }
  });
});
