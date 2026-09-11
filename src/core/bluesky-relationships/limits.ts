/**
 * How much relationship work one operator request may do.
 *
 * Pure, client-safe: the UI caps selection with the same constant the
 * server action rejects on, so the two cannot drift.
 *
 * WHY A CAP AT ALL
 * ----------------
 * A batch runs SYNCHRONOUSLY inside the request the operator started.
 * There is no queue and no background worker — deliberately, because
 * "explicitly initiated by the operator" is the product boundary this
 * subsystem is built around. That makes the serverless execution
 * budget a real constraint rather than a theoretical one.
 *
 * THE ARITHMETIC
 * --------------
 * Per action, measured against the live API (see the Phase 0 audit and
 * the live smoke: provider round trips ran 0.45-1.0s):
 *
 *   success path    1 mutation call (~0.8s) + INTER_REQUEST_MS (1.0s)
 *   ambiguous path  1 mutation call + 1 relationship read (~1.6s)
 *                   + INTER_REQUEST_MS
 *
 * Spacing applies between requests, so n-1 times. For n actions:
 *
 *   realistic   0.8n + (n - 1)  = 1.8n - 1
 *   worst case  1.6n + (n - 1)  = 2.6n - 1      (every action ambiguous)
 *
 * Against the 60s `maxDuration` declared on the relationships page
 * segment:
 *
 *   n = 20   realistic 35s   worst 51s    fits
 *   n = 25   realistic 44s   worst 64s    does NOT fit
 *
 * Hence 20. The spacing itself is NOT reduced to buy headroom — it is
 * there to stay comfortably inside Bluesky's published limit, and
 * trading provider courtesy for batch size would be the wrong direction.
 *
 * WHAT HAPPENS IF IT STILL TIMES OUT
 * ----------------------------------
 * Nothing is lost. Every action persists its own terminal state before
 * the next one starts, so a timeout leaves succeeded rows succeeded and
 * untouched rows `pending` — exactly the shape the operator-triggered
 * Continue resumes. The cap is there to make a timeout unlikely, not to
 * make it survivable; it is already survivable.
 *
 * This is a bound on ONE request, not a quota. There is no daily limit,
 * no cooldown, and nothing that meters an operator over time.
 */

/**
 * Maximum relationship mutations in a single operator-confirmed batch.
 *
 * Enforced in BOTH places: the UI refuses to select past it, and the
 * server action rejects a FormData that carries more. The server check
 * is the real one — client state is never trusted.
 */
export const MAX_RELATIONSHIP_BATCH_SIZE = 20;

/**
 * `maxDuration` for the relationships page segment, in seconds.
 *
 * Exported so the page and this arithmetic cannot drift apart, and so a
 * test can assert the page actually declares it. Vercel's default for
 * this account's plan is far lower than the worst case above, which is
 * why it is declared explicitly rather than left implicit.
 */
export const RELATIONSHIP_MAX_DURATION_SECONDS = 60;

export type BatchSizeCheck =
  | { ok: true; count: number }
  | { ok: false; count: number; reason: string };

/**
 * Validate a selection size.
 *
 * Takes the count rather than the ids so the server can check a forged
 * FormData before it has resolved anything, and the client can check a
 * Set before it has built a payload.
 */
export function checkBatchSize(count: number): BatchSizeCheck {
  if (!Number.isInteger(count) || count < 0) {
    return {
      ok: false,
      count,
      reason: "Selection size is not a whole number.",
    };
  }
  if (count === 0) {
    return { ok: false, count, reason: "Select at least one account." };
  }
  if (count > MAX_RELATIONSHIP_BATCH_SIZE) {
    return {
      ok: false,
      count,
      reason: `Select at most ${MAX_RELATIONSHIP_BATCH_SIZE} accounts at a time. This batch runs while you wait, so it is bounded to finish inside one request — ${count} were submitted. Run it in smaller batches; each one is recorded separately and nothing is lost between them.`,
    };
  }
  return { ok: true, count };
}

/** Whether adding one more selection would exceed the cap. */
export function canSelectMore(currentCount: number): boolean {
  return currentCount < MAX_RELATIONSHIP_BATCH_SIZE;
}

/**
 * How many of `available` may still be selected.
 *
 * Used by "Select visible", which selects up to the cap rather than
 * silently selecting everything and failing at submit.
 */
export function remainingSelectionCapacity(currentCount: number): number {
  return Math.max(0, MAX_RELATIONSHIP_BATCH_SIZE - currentCount);
}
