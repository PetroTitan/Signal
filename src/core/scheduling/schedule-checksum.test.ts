import { describe, expect, it } from "vitest";
import {
  assertScheduleUnchanged,
  compareScheduleChecksums,
  detectIsoDrift,
  scheduleChecksum,
} from "./schedule-checksum";

describe("scheduleChecksum stability", () => {
  it("is deterministic for the same input", () => {
    const a = scheduleChecksum({
      itemId: "item-1",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "Europe/Prague",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "item-1",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "Europe/Prague",
      source: "manual",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces different checksums for different itemIds", () => {
    const a = scheduleChecksum({
      itemId: "item-1",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "item-2",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    expect(a).not.toBe(b);
  });

  it("produces different checksums for different timestamps", () => {
    const a = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:02:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    expect(a).not.toBe(b);
  });

  it("treats equivalent ISO strings as the same checksum", () => {
    // These two ISO strings represent the same instant.
    const a = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T16:01:00-04:00",
      timezone: "UTC",
      source: "manual",
    });
    expect(a).toBe(b);
  });

  it("distinguishes null ISO from real ISO", () => {
    const a = scheduleChecksum({
      itemId: "i",
      iso: null,
      timezone: "UTC",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    expect(a).not.toBe(b);
  });

  it("differs when source changes", () => {
    const a = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "UTC",
      source: "mcp",
    });
    expect(a).not.toBe(b);
  });

  it("differs when timezone changes (audit trail)", () => {
    const a = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "Europe/Prague",
      source: "manual",
    });
    const b = scheduleChecksum({
      itemId: "i",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "America/New_York",
      source: "manual",
    });
    expect(a).not.toBe(b);
  });
});

describe("compareScheduleChecksums", () => {
  it("returns match for identical checksums", () => {
    expect(compareScheduleChecksums("abc12345", "abc12345")).toBe("match");
  });
  it("returns drift otherwise", () => {
    expect(compareScheduleChecksums("abc12345", "deadbeef")).toBe("drift");
  });
});

describe("detectIsoDrift", () => {
  it("returns 0 for identical ISO strings", () => {
    expect(
      detectIsoDrift(
        "2026-05-20T20:01:00.000Z",
        "2026-05-20T20:01:00.000Z",
      ),
    ).toBe(0);
  });

  it("returns positive drift for shifted ISO strings", () => {
    const drift = detectIsoDrift(
      "2026-05-20T20:01:00.000Z",
      "2026-05-20T16:01:00.000Z",
    );
    expect(drift).toBe(4 * 60 * 60 * 1000); // 4 hours in ms
  });

  it("returns Infinity for invalid input", () => {
    expect(detectIsoDrift("not-a-date", "2026-05-20T20:01:00.000Z")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("detects sub-second drift", () => {
    expect(
      detectIsoDrift(
        "2026-05-20T20:01:00.000Z",
        "2026-05-20T20:01:00.500Z",
      ),
    ).toBe(500);
  });
});

describe("assertScheduleUnchanged", () => {
  const base = {
    itemId: "item-1",
    iso: "2026-05-20T20:01:00.000Z",
    timezone: "Europe/Prague",
    source: "manual" as const,
  };

  it("returns ok when the schedule is unchanged", () => {
    const r = assertScheduleUnchanged(base, base);
    expect(r.ok).toBe(true);
    expect(r.beforeChecksum).toBe(r.afterChecksum);
  });

  it("identifies iso drift in the reason", () => {
    const r = assertScheduleUnchanged(base, {
      ...base,
      iso: "2026-05-20T16:01:00.000Z",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("iso");
    expect(r.beforeChecksum).not.toBe(r.afterChecksum);
  });

  it("identifies source drift", () => {
    const r = assertScheduleUnchanged(base, {
      ...base,
      source: "mcp",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("source");
  });

  it("identifies timezone drift", () => {
    const r = assertScheduleUnchanged(base, {
      ...base,
      timezone: "Asia/Tokyo",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("timezone");
  });

  it("never throws — caller decides what to do", () => {
    expect(() =>
      assertScheduleUnchanged(base, {
        ...base,
        iso: "garbage",
      }),
    ).not.toThrow();
  });
});

describe("replay consistency", () => {
  it("re-running serialization 20 times preserves the checksum", () => {
    const input = {
      itemId: "item-1",
      iso: "2026-05-20T20:01:00.000Z",
      timezone: "Europe/Prague",
      source: "manual" as const,
    };
    const initial = scheduleChecksum(input);
    for (let i = 0; i < 20; i++) {
      expect(scheduleChecksum(input)).toBe(initial);
    }
  });
});
