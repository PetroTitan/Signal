import { describe, expect, it } from "vitest";
import {
  evaluateRetryEligibility,
  evaluateRetryEligibilityFromMetadata,
  readPersistedPublishOutcome,
} from "./retry-eligibility";

/**
 * P0.2 — the retry firewall predicate.
 *
 * Locked semantics:
 *   A safe retry          may retry
 *   B conditional retry   may retry with backoff
 *   C unknown outcome     never automatically, never generic "Try again"
 *   D partial success     never blindly; explicit operator recovery
 *   E confirmed published never
 */

const outcome = (o: Record<string, unknown>) => o as never;

describe("evaluateRetryEligibility", () => {
  it("treats a never-attempted item as freely schedulable", () => {
    const r = evaluateRetryEligibility(null);
    expect(r.outcomeClass).toBe("no_prior_attempt");
    expect(r.automaticRetryAllowed).toBe(true);
    expect(r.operatorRetryAllowed).toBe(true);
    expect(r.refusalCode).toBe(null);
  });

  it("class E — refuses everything when a provider id is recorded", () => {
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", reason_code: "whatever", external_id: "t3_abc" }),
    );
    expect(r.outcomeClass).toBe("confirmed_published");
    expect(r.automaticRetryAllowed).toBe(false);
    expect(r.operatorRetryAllowed).toBe(false);
    expect(r.refusalCode).toBe("retry_refused_already_published");
  });

  it("class E — a permalink alone is proof of publication", () => {
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", external_url: "https://example.com/p/1" }),
    );
    expect(r.outcomeClass).toBe("confirmed_published");
    expect(r.operatorRetryAllowed).toBe(false);
  });

  it("class E — provider evidence outranks a contradictory status field", () => {
    // If we hold an id, the post exists, whatever the row says.
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", reason_code: "platform_api_error", external_id: "abc" }),
    );
    expect(r.outcomeClass).toBe("confirmed_published");
  });

  it("class E — status 'published' with no id still refuses", () => {
    const r = evaluateRetryEligibility(outcome({ status: "published" }));
    expect(r.outcomeClass).toBe("confirmed_published");
    expect(r.operatorRetryAllowed).toBe(false);
  });

  it("class D — partial success requires explicit recovery, never a blind retry", () => {
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", reason_code: "publish_partial_success" }),
    );
    expect(r.outcomeClass).toBe("partial_success");
    expect(r.automaticRetryAllowed).toBe(false);
    expect(r.operatorRetryAllowed).toBe(false);
    expect(r.requiresExplicitRecovery).toBe(true);
    expect(r.refusalCode).toBe("retry_refused_partial_success");
    // The operator must be told that parts are already live.
    expect(r.reason).toMatch(/already live/i);
  });

  it("class C — unknown outcome refuses both automatic and generic retry", () => {
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", reason_code: "publish_outcome_unknown" }),
    );
    expect(r.outcomeClass).toBe("unknown_outcome");
    expect(r.automaticRetryAllowed).toBe(false);
    expect(r.operatorRetryAllowed).toBe(false);
    expect(r.requiresExplicitRecovery).toBe(true);
    expect(r.refusalCode).toBe("retry_refused_unknown_outcome");
    expect(r.reason).toMatch(/couldn't confirm/i);
  });

  it("class A/B — an ordinary failure stays retryable", () => {
    for (const code of [
      "platform_rate_limited",
      "x_network_error",
      "devto_validation_error",
      "missing_subreddit",
      "platform_unauthorized",
    ]) {
      const r = evaluateRetryEligibility(
        outcome({ status: "failed", reason_code: code }),
      );
      expect(r.outcomeClass).toBe("safe_or_conditional_retry");
      expect(r.operatorRetryAllowed).toBe(true);
    }
  });

  it("every refusal carries an operator-readable reason", () => {
    for (const o of [
      { status: "failed", reason_code: "publish_outcome_unknown" },
      { status: "failed", reason_code: "publish_partial_success" },
      { status: "published" },
    ]) {
      const r = evaluateRetryEligibility(outcome(o));
      expect(r.operatorRetryAllowed).toBe(false);
      expect(r.reason.length).toBeGreaterThan(20);
    }
  });

  it("ignores empty-string provider evidence (a blank id is not proof)", () => {
    const r = evaluateRetryEligibility(
      outcome({ status: "failed", reason_code: "platform_api_error", external_id: "", external_url: "  " }),
    );
    expect(r.outcomeClass).toBe("safe_or_conditional_retry");
  });
});

describe("readPersistedPublishOutcome", () => {
  it("extracts the outcome from a metadata bag", () => {
    const o = readPersistedPublishOutcome({
      publish_outcome: { status: "failed", reason_code: "publish_outcome_unknown" },
    });
    expect(o?.reason_code).toBe("publish_outcome_unknown");
  });

  it("tolerates every shape metadata can take without throwing", () => {
    for (const bad of [null, undefined, {}, "string", 42, [], { publish_outcome: null }, { publish_outcome: "x" }]) {
      expect(readPersistedPublishOutcome(bad)).toBe(null);
    }
  });

  it("classifies straight from a metadata bag", () => {
    const r = evaluateRetryEligibilityFromMetadata({
      retry: { attempt: 2 },
      publish_outcome: { status: "failed", reason_code: "publish_partial_success" },
    });
    expect(r.outcomeClass).toBe("partial_success");
  });

  it("an item with metadata but no recorded outcome is treated as never attempted", () => {
    const r = evaluateRetryEligibilityFromMetadata({ plan_item_id: "abc" });
    expect(r.outcomeClass).toBe("no_prior_attempt");
    expect(r.operatorRetryAllowed).toBe(true);
  });
});
