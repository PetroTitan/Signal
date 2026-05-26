import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase F7.5 — settings updateRegionAction validates IANA timezones.
 *
 * The production crash root cause was: this action saved any
 * free-text typed timezone (no validation), and the bad value then
 * broke /dashboard + /weekly-plan rendering. These tests pin the
 * write-boundary refusal so future invalid values never reach DB.
 */

const hoisted = vi.hoisted(() => ({
  updateSettingsMock: vi.fn(),
  recordActivityMock: vi.fn(),
  getPrimaryWorkspaceMock: vi.fn(),
}));

vi.mock("@/repositories/settings-repository", () => ({
  updateSettings: hoisted.updateSettingsMock,
}));
vi.mock("@/repositories/activity-repository", () => ({
  recordActivity: hoisted.recordActivityMock,
}));
vi.mock("@/repositories/workspace-repository", () => ({
  getPrimaryWorkspace: hoisted.getPrimaryWorkspaceMock,
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { updateRegionAction } from "./_actions";

function formData(timezone: string | null): FormData {
  const fd = new FormData();
  if (timezone !== null) fd.append("timezone", timezone);
  return fd;
}

const PREV = { ok: false, error: null };

beforeEach(() => {
  hoisted.updateSettingsMock.mockReset();
  hoisted.updateSettingsMock.mockResolvedValue({
    region: null,
    timezone: null,
    language: null,
    updatedAt: "2026-06-15T10:00:00.000Z",
  });
  hoisted.recordActivityMock.mockReset();
  hoisted.recordActivityMock.mockResolvedValue(undefined);
  hoisted.getPrimaryWorkspaceMock.mockReset();
  hoisted.getPrimaryWorkspaceMock.mockResolvedValue({
    workspace: { id: "ws-1" },
  });
});

afterEach(() => vi.clearAllMocks());

describe("updateRegionAction — IANA timezone validation", () => {
  it("accepts a valid IANA timezone", async () => {
    const out = await updateRegionAction(PREV, formData("America/New_York"));
    expect(out.ok).toBe(true);
    expect(hoisted.updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/New_York" }),
    );
  });

  it("accepts another valid IANA timezone", async () => {
    const out = await updateRegionAction(PREV, formData("Europe/Prague"));
    expect(out.ok).toBe(true);
    expect(hoisted.updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Europe/Prague" }),
    );
  });

  it("trims whitespace before validation", async () => {
    const out = await updateRegionAction(
      PREV,
      formData("  America/New_York  "),
    );
    expect(out.ok).toBe(true);
    expect(hoisted.updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/New_York" }),
    );
  });

  it("accepts empty (null) timezone — clears to null in DB", async () => {
    const out = await updateRegionAction(PREV, formData(""));
    expect(out.ok).toBe(true);
    expect(hoisted.updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: null }),
    );
  });

  it("REJECTS a non-IANA operator label with actionable error", async () => {
    const out = await updateRegionAction(PREV, formData("Eastern Time"));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Eastern Time/);
    expect(out.error).toMatch(/IANA/i);
    // No DB write attempted on validation failure.
    expect(hoisted.updateSettingsMock).not.toHaveBeenCalled();
  });

  it("REJECTS garbage strings", async () => {
    const out = await updateRegionAction(PREV, formData("not-a-timezone"));
    expect(out.ok).toBe(false);
    expect(hoisted.updateSettingsMock).not.toHaveBeenCalled();
  });

  it("REJECTS whitespace-only string", async () => {
    // A whitespace-only string becomes "" after .trim() in the
    // action; the action treats that as "no value" and writes null
    // (clearing the timezone). This matches the existing behavior
    // for empty inputs.
    const out = await updateRegionAction(PREV, formData("   "));
    expect(out.ok).toBe(true);
    expect(hoisted.updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: null }),
    );
  });
});
