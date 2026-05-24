import { describe, expect, it } from "vitest";
import { newAccountCaps } from "./new-account-mode";
import type { QaIdentity } from "./types";

function identity(overrides: Partial<QaIdentity> = {}): QaIdentity {
  return {
    platform: "x",
    ageDays: 100,
    displayName: "Test",
    handle: null,
    status: "active",
    ...overrides,
  };
}

describe("newAccountCaps", () => {
  it("returns isNewAccount=false for a mature, active identity", () => {
    const caps = newAccountCaps(identity());
    expect(caps.isNewAccount).toBe(false);
    expect(caps.allowThreads).toBe(true);
    expect(caps.allowLaunchLanguage).toBe(true);
  });

  it("returns isNewAccount=true for a 3-day-old identity", () => {
    const caps = newAccountCaps(identity({ ageDays: 3, status: "warming" }));
    expect(caps.isNewAccount).toBe(true);
    expect(caps.warmUpDaysRemaining).toBe(11);
  });

  it("blocks threads for warming X identity", () => {
    const caps = newAccountCaps(identity({ ageDays: 1, status: "warming" }));
    expect(caps.allowThreads).toBe(false);
  });

  it("allows threads for warming devto identity (long-form is the medium)", () => {
    const caps = newAccountCaps(
      identity({ ageDays: 1, status: "warming", platform: "devto" }),
    );
    expect(caps.allowThreads).toBe(true);
  });

  it("treats 'planned' status as new even at older ages", () => {
    const caps = newAccountCaps(identity({ ageDays: 200, status: "planned" }));
    expect(caps.isNewAccount).toBe(true);
  });

  it("limits hashtags during warming", () => {
    const caps = newAccountCaps(identity({ ageDays: 1, status: "warming" }));
    expect(caps.maxHashtagsPerItem).toBeLessThanOrEqual(2);
  });

  it("disallows launch language while warming", () => {
    const caps = newAccountCaps(identity({ ageDays: 1, status: "warming" }));
    expect(caps.allowLaunchLanguage).toBe(false);
  });
});
