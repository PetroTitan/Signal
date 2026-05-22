/**
 * Retry policy for execution items.
 *
 * The runner respects `max_attempts` (default 3). Soft-block and
 * transient-failure outcomes can be retried; hard_block outcomes can
 * not — the contract said no, and re-running will say no again.
 */

import type { ExecutionItem } from "./execution-types";

export interface RetryDecision {
  shouldRetry: boolean;
  reason: string;
  nextAttemptNumber: number | null;
  /** Suggested delay before the next attempt. Phase E2 has no real
   *  scheduler so this is informational; the UI surfaces it to the
   *  operator. */
  delayMs: number;
}

export interface RetryPolicyInput {
  item: ExecutionItem;
  lastOutcome: "succeeded" | "failed" | "blocked" | "skipped";
  /** Whether the failure looked transient (timeout, network). */
  transient?: boolean;
}

export function evaluateRetry(input: RetryPolicyInput): RetryDecision {
  const { item, lastOutcome, transient } = input;

  if (lastOutcome === "succeeded" || lastOutcome === "skipped") {
    return {
      shouldRetry: false,
      reason: `Outcome was ${lastOutcome}; no retry needed.`,
      nextAttemptNumber: null,
      delayMs: 0,
    };
  }

  if (lastOutcome === "blocked") {
    return {
      shouldRetry: false,
      reason: "Hard block from the contract layer — retry will not change the verdict.",
      nextAttemptNumber: null,
      delayMs: 0,
    };
  }

  if (item.attemptCount >= item.maxAttempts) {
    return {
      shouldRetry: false,
      reason: `Reached max_attempts (${item.maxAttempts}).`,
      nextAttemptNumber: null,
      delayMs: 0,
    };
  }

  if (!transient) {
    return {
      shouldRetry: false,
      reason: "Failure looked non-transient; surfacing to operator instead of retrying.",
      nextAttemptNumber: null,
      delayMs: 0,
    };
  }

  // Backoff: 30s, 2m, 5m. Caps at max_attempts.
  const delays = [30_000, 120_000, 300_000];
  const nextIndex = Math.min(item.attemptCount, delays.length - 1);
  return {
    shouldRetry: true,
    reason: "Transient failure within retry budget.",
    nextAttemptNumber: item.attemptCount + 1,
    delayMs: delays[nextIndex] ?? delays[delays.length - 1]!,
  };
}
