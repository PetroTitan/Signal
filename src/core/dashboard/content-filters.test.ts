import { describe, expect, it } from "vitest";
import {
  contentFiltersToQuery,
  decodeSavedViews,
  encodeSavedViews,
  isContentFilterActive,
  parseContentFilters,
  removeSavedView,
  upsertSavedView,
  type SavedView,
} from "./content-filters";

describe("parseContentFilters", () => {
  it("parses all params, trimming + normalizing empties to null", () => {
    const f = parseContentFilters({
      q: "  launch ",
      platform: "bluesky",
      status: "scheduled",
      account: "acct-1",
      product: "prod-1",
      since: "2026-06-01",
      until: "2026-06-30",
    });
    expect(f).toEqual({
      q: "launch",
      platform: "bluesky",
      status: "scheduled",
      accountId: "acct-1",
      productId: "prod-1",
      since: "2026-06-01",
      until: "2026-06-30",
    });
  });

  it("rejects malformed date bounds", () => {
    const f = parseContentFilters({ since: "june", until: "2026/06/30" });
    expect(f.since).toBeNull();
    expect(f.until).toBeNull();
  });

  it("defaults to empty when no params", () => {
    expect(isContentFilterActive(parseContentFilters(undefined))).toBe(false);
  });

  it("takes the first value of array params", () => {
    expect(parseContentFilters({ platform: ["x", "bluesky"] }).platform).toBe("x");
  });
});

describe("contentFiltersToQuery round-trip", () => {
  it("serializes only set fields and re-parses identically", () => {
    const f = parseContentFilters({ q: "hi", platform: "x", status: "published" });
    const qs = contentFiltersToQuery(f);
    expect(qs).toContain("q=hi");
    expect(qs).toContain("platform=x");
    expect(qs).toContain("status=published");
    // Re-parse: URLSearchParams keys map back through parseContentFilters.
    const params = Object.fromEntries(new URLSearchParams(qs));
    expect(parseContentFilters(params)).toEqual(f);
  });

  it("empty state serializes to empty string", () => {
    expect(contentFiltersToQuery(parseContentFilters(undefined))).toBe("");
  });
});

describe("saved views", () => {
  const view: SavedView = {
    id: "v1",
    name: "Bluesky this month",
    filters: parseContentFilters({ platform: "bluesky", since: "2026-06-01" }),
  };

  it("encode → decode round-trips", () => {
    const decoded = decodeSavedViews(encodeSavedViews([view]));
    expect(decoded).toEqual([view]);
  });

  it("decode tolerates malformed input (never throws)", () => {
    expect(decodeSavedViews(null)).toEqual([]);
    expect(decodeSavedViews("not json")).toEqual([]);
    expect(decodeSavedViews("{}")).toEqual([]);
    expect(decodeSavedViews('[{"name":"no id"}]')).toEqual([]);
  });

  it("upsert creates then replaces by id", () => {
    let views = upsertSavedView([], view);
    expect(views).toHaveLength(1);
    views = upsertSavedView(views, { ...view, name: "Renamed" });
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("Renamed");
  });

  it("remove drops the matching id (deleted view disappears)", () => {
    const views = upsertSavedView([], view);
    expect(removeSavedView(views, "v1")).toEqual([]);
    expect(removeSavedView(views, "nope")).toEqual(views);
  });
});
