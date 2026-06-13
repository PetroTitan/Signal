import { describe, expect, it } from "vitest";
import { summarizeAttentionItems, type AttentionSummaryInput } from "./attention-summary";

function emptyInput(): AttentionSummaryInput {
  return {
    failedPublishes: [],
    blockedItems: [],
    retryingItems: [],
    staleClaims: [],
    expiredConnections: [],
    carryOverCount: 0,
  };
}

describe("summarizeAttentionItems", () => {
  it("returns nothing for a clean workspace (no false positives)", () => {
    const s = summarizeAttentionItems(emptyInput());
    expect(s.totalCount).toBe(0);
    expect(s.entries).toHaveLength(0);
    expect(s.digestText).toBe("");
  });

  it("surfaces a failed publish with an open link", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      failedPublishes: [{ id: "p1", where: "r/startups", executionItemId: "ei-1" }],
    });
    expect(s.counts.failed).toBe(1);
    expect(s.entries[0].href).toBe("/execution/items/ei-1");
    expect(s.entries[0].severity).toBe("danger");
  });

  it("distinguishes retry-exhausted failures in the message + digest", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      failedPublishes: [{ id: "p1", where: "bluesky", executionItemId: "ei-1", retryExhausted: true }],
    });
    expect(s.counts.retryExhausted).toBe(1);
    expect(s.entries[0].message).toMatch(/retries are exhausted/i);
    expect(s.digestText).toMatch(/retries exhausted/i);
  });

  it("surfaces blocked items pointing at the queue/detail", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      blockedItems: [{ id: "b1", title: "Launch", reasonCode: "creative_missing_alt_text", executionItemId: "ei-2" }],
    });
    expect(s.counts.blocked).toBe(1);
    expect(s.entries[0].message).toMatch(/blocked/i);
    expect(s.entries[0].message).toMatch(/creative missing alt text/i);
  });

  it("surfaces a reauth-required / expired connection", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      expiredConnections: [{ id: "c1", platformLabel: "X" }],
    });
    expect(s.counts.expiredConnections).toBe(1);
    expect(s.entries[0].cta).toBe("Reconnect X");
    expect(s.entries[0].href).toBe("/accounts");
  });

  it("surfaces a retrying item with its next-retry time and attempt count", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      retryingItems: [{ id: "ei-3", title: "Tip", nextRetryAtIso: "2026-06-13T12:05:00.000Z", attemptCount: 1, maxAttempts: 3 }],
    });
    expect(s.counts.retrying).toBe(1);
    expect(s.entries[0].severity).toBe("info");
    expect(s.entries[0].message).toMatch(/12:05 UTC/);
    expect(s.entries[0].message).toMatch(/attempt 2 of 3/);
  });

  it("surfaces a stale claim as a manual-check danger (possible double-publish)", () => {
    const s = summarizeAttentionItems({
      ...emptyInput(),
      staleClaims: [{ id: "ei-4", title: "Thread", claimedAtIso: "2026-06-13T11:00:00.000Z" }],
    });
    expect(s.counts.staleClaims).toBe(1);
    expect(s.entries[0].severity).toBe("danger");
    expect(s.entries[0].message).toMatch(/never finished/i);
    expect(s.entries[0].message).toMatch(/may already be live/i);
  });

  it("surfaces a carry-over count", () => {
    const s = summarizeAttentionItems({ ...emptyInput(), carryOverCount: 4 });
    expect(s.counts.carryOver).toBe(4);
    expect(s.entries[0].message).toMatch(/4 unfinished item/);
  });

  it("orders danger before warn before info, and caps rendered entries", () => {
    const s = summarizeAttentionItems({
      failedPublishes: [{ id: "p1", where: "x", executionItemId: "ei-1" }],
      blockedItems: [],
      retryingItems: [{ id: "ei-3", title: "t", nextRetryAtIso: null, attemptCount: 0, maxAttempts: 3 }],
      staleClaims: [],
      expiredConnections: [{ id: "c1", platformLabel: "Reddit" }],
      carryOverCount: 0,
      maxEntries: 2,
    });
    expect(s.entries).toHaveLength(2); // capped
    expect(s.entries[0].severity).toBe("danger"); // failed first
    expect(s.entries[1].severity).toBe("warn"); // expired connection next
    expect(s.totalCount).toBe(3); // not capped
  });

  it("builds a source-of-truth digest summarizing every category", () => {
    const s = summarizeAttentionItems({
      failedPublishes: [{ id: "p1", where: "x", executionItemId: "ei-1", retryExhausted: true }],
      blockedItems: [{ id: "b1", title: "x", reasonCode: null, executionItemId: null }],
      retryingItems: [{ id: "ei-3", title: "t", nextRetryAtIso: null, attemptCount: 0, maxAttempts: 3 }],
      staleClaims: [{ id: "ei-4", title: "z", claimedAtIso: null }],
      expiredConnections: [{ id: "c1", platformLabel: "X" }],
      carryOverCount: 2,
    });
    expect(s.digestText).toMatch(/1 failed publish/);
    expect(s.digestText).toMatch(/retries exhausted/);
    expect(s.digestText).toMatch(/never finished/);
    expect(s.digestText).toMatch(/1 blocked item/);
    expect(s.digestText).toMatch(/1 expired platform connection/);
    expect(s.digestText).toMatch(/1 item retrying/);
    expect(s.digestText).toMatch(/2 unfinished/);
  });
});
