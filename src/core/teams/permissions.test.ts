import { describe, expect, it } from "vitest";
import { can, canAny, ROLE_PERMISSIONS, roleLabel } from "./permissions";

describe("role permission matrix", () => {
  it("owner can do everything including transfer + billing", () => {
    expect(can("owner", "transfer_ownership")).toBe(true);
    expect(can("owner", "manage_billing")).toBe(true);
    expect(can("owner", "manage_members")).toBe(true);
    expect(can("owner", "approve_content")).toBe(true);
  });

  it("admin manages members/settings/platforms but NOT transfer or billing", () => {
    expect(can("admin", "manage_members")).toBe(true);
    expect(can("admin", "manage_settings")).toBe(true);
    expect(can("admin", "connect_platforms")).toBe(true);
    expect(can("admin", "invite_members")).toBe(true);
    expect(can("admin", "transfer_ownership")).toBe(false);
    expect(can("admin", "manage_billing")).toBe(false);
  });

  it("reviewer CAN review + approve content/creatives", () => {
    expect(can("reviewer", "view_content")).toBe(true);
    expect(can("reviewer", "review_content")).toBe(true);
    expect(can("reviewer", "approve_content")).toBe(true);
    expect(can("reviewer", "approve_creative")).toBe(true);
  });

  it("reviewer CANNOT manage settings/members/platforms/billing/transfer", () => {
    expect(can("reviewer", "manage_settings")).toBe(false);
    expect(can("reviewer", "manage_members")).toBe(false);
    expect(can("reviewer", "connect_platforms")).toBe(false);
    expect(can("reviewer", "manage_billing")).toBe(false);
    expect(can("reviewer", "transfer_ownership")).toBe(false);
    // review-only: does not author content.
    expect(can("reviewer", "edit_content")).toBe(false);
  });

  it("editor authors + approves but cannot manage members", () => {
    expect(can("editor", "edit_content")).toBe(true);
    expect(can("editor", "approve_content")).toBe(true);
    expect(can("editor", "manage_members")).toBe(false);
    expect(can("editor", "connect_platforms")).toBe(false);
  });

  it("viewer is read-only", () => {
    expect(can("viewer", "view_content")).toBe(true);
    expect(can("viewer", "approve_content")).toBe(false);
    expect(can("viewer", "edit_content")).toBe(false);
    expect([...ROLE_PERMISSIONS.viewer]).toEqual(["view_content"]);
  });

  it("null role denies everything", () => {
    expect(can(null, "view_content")).toBe(false);
    expect(can(undefined, "approve_content")).toBe(false);
  });

  it("canAny short-circuits across permissions", () => {
    expect(canAny("reviewer", ["manage_members", "approve_content"])).toBe(true);
    expect(canAny("viewer", ["manage_members", "edit_content"])).toBe(false);
  });

  it("provides labels for every role", () => {
    for (const r of ["owner", "admin", "editor", "reviewer", "viewer"] as const) {
      expect(roleLabel(r).length).toBeGreaterThan(0);
    }
  });
});
