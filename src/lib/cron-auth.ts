import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared bearer-secret auth for the Vercel-Cron-triggered routes:
 *   - /api/scheduler/tick
 *   - /api/notifications/digest
 *   - /api/metrics/refresh
 *
 * Why this exists
 * ---------------
 * Vercel Cron automatically attaches `Authorization: Bearer <CRON_SECRET>`
 * (from the CRON_SECRET env var) to every scheduled invocation; it cannot
 * send a custom header. The original routes only accepted
 * SCHEDULER_TICK_TOKEN, so a correctly-configured Vercel deployment would
 * 401 on every cron fire and the scheduler / digests / metrics would
 * silently never run. This helper accepts EITHER secret:
 *
 *   - CRON_SECRET          — the secret Vercel Cron sends. Preferred.
 *   - SCHEDULER_TICK_TOKEN — retained for backward-compatible manual
 *                            (curl) triggering and existing deployments.
 *
 * Contract
 * --------
 *   - Neither env set               → 503 (honestly unconfigured).
 *   - A secret is set, header valid → authorized.
 *   - A secret is set, header bad   → 401.
 *
 * The comparison is constant-time: both sides are SHA-256'd to a fixed
 * length before `timingSafeEqual`, so neither the secret's length nor its
 * content leaks through response timing (and unequal input lengths don't
 * throw). Every configured secret is always checked (no short-circuit) so
 * the number of comparisons doesn't depend on which one matched.
 */

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEquals(a: string, b: string): boolean {
  // SHA-256 both sides → equal-length digests → timingSafeEqual is safe
  // and constant-time regardless of the raw input lengths.
  return timingSafeEqual(sha256(a), sha256(b));
}

function configuredSecrets(): string[] {
  return [process.env.CRON_SECRET, process.env.SCHEDULER_TICK_TOKEN]
    .map((v) => v?.trim())
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function authorizeCronRequest(request: Request): CronAuthResult {
  const secrets = configuredSecrets();
  if (secrets.length === 0) {
    return {
      ok: false,
      status: 503,
      error:
        "Cron auth not configured: set CRON_SECRET (sent by Vercel Cron) or SCHEDULER_TICK_TOKEN (manual).",
    };
  }

  const provided = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(provided.trim());
  if (!match) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  const token = match[1].trim();
  // Check every configured secret without short-circuiting.
  let authorized = false;
  for (const secret of secrets) {
    if (constantTimeEquals(token, secret)) authorized = true;
  }
  if (!authorized) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }
  return { ok: true };
}
