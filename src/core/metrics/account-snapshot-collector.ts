import "server-only";
/**
 * Scheduled account-context collection.
 *
 * Runs inside the existing metrics sweep rather than on a cron of its
 * own. The sweep is already the measurement orchestration boundary, it
 * already holds the service-role client, and it already knows which
 * accounts published — adding a second scheduled job would mean two
 * things to keep alive, two things to diagnose, and two cron entries
 * competing for the same provider rate limits.
 *
 * ISOLATION IS THE CONTRACT HERE:
 *   - one account failing must not stop the others;
 *   - X failing must not prevent Bluesky;
 *   - an account-snapshot failure must never discard the post metrics
 *     the same sweep just wrote.
 *
 * Every one of those is enforced by a try/catch per account plus a
 * per-provider partition, and asserted by test.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchBlueskyAccountSnapshot,
  fetchXAccountSnapshot,
} from "./account-snapshot-reader";
import {
  accountsDueForSnapshot,
  listLatestAccountSnapshots,
  persistAccountSnapshot,
  persistAccountSnapshotFailure,
} from "@/repositories/account-snapshot-repository";
import { metricSource } from "./metrics-provider";
import type { AccountSnapshot } from "./account-context";

/** Providers whose account context Signal can read. */
export const SNAPSHOTTABLE_PLATFORMS = ["bluesky", "x"] as const;
export type SnapshottablePlatform = (typeof SNAPSHOTTABLE_PLATFORMS)[number];

/** Ceiling per run, so a workspace with many identities cannot turn one
 *  sweep into an unbounded provider crawl. */
export const MAX_ACCOUNTS_PER_RUN = 25;

export interface SnapshotTarget {
  workspaceId: string;
  accountId: string;
  platform: string;
  /** Provider handle — Bluesky needs it; X resolves from the token. */
  handle: string | null;
}

export interface CollectResult {
  attempted: number;
  written: number;
  failed: number;
  skippedNotDue: number;
  byPlatform: Record<string, { attempted: number; written: number; failed: number }>;
  notes: string[];
}

export interface CollectorDeps {
  db: SupabaseClient;
  /** Injected so provider behaviour is testable without a network. */
  readBluesky?: typeof fetchBlueskyAccountSnapshot;
  readX?: typeof fetchXAccountSnapshot;
}

export function isSnapshottable(platform: string): platform is SnapshottablePlatform {
  return (SNAPSHOTTABLE_PLATFORMS as readonly string[]).includes(platform);
}

export async function collectAccountSnapshots(
  targets: readonly SnapshotTarget[],
  nowIso: string,
  deps: CollectorDeps,
): Promise<CollectResult> {
  const result: CollectResult = {
    attempted: 0,
    written: 0,
    failed: 0,
    skippedNotDue: 0,
    byPlatform: {},
    notes: [],
  };

  const supported = dedupeTargets(targets).filter((t) => isSnapshottable(t.platform));
  if (supported.length === 0) {
    result.notes.push("No accounts on a platform whose profile Signal can read.");
    return result;
  }

  // Which accounts already have today's snapshot. A read failure here is
  // not fatal — it just means we may re-read an account we already have,
  // which is free on Bluesky and one billable resource on X.
  let latest = new Map<string, { fetchedAt: string }>();
  const workspaceIds = Array.from(new Set(supported.map((t) => t.workspaceId)));
  for (const workspaceId of workspaceIds) {
    try {
      const rows = await listLatestAccountSnapshots(workspaceId, deps.db);
      for (const [accountId, record] of rows) {
        latest.set(accountId, { fetchedAt: record.fetchedAt });
      }
    } catch (err) {
      result.notes.push(
        `Could not read existing snapshots for a workspace; proceeding as if none exist. ${errText(err)}`,
      );
    }
  }

  const due = accountsDueForSnapshot(supported, latest, nowIso);
  result.skippedNotDue = supported.length - due.length;
  if (result.skippedNotDue > 0) {
    result.notes.push(
      `${result.skippedNotDue} account(s) already have today's snapshot.`,
    );
  }

  const batch = due.slice(0, MAX_ACCOUNTS_PER_RUN);
  if (due.length > batch.length) {
    result.notes.push(
      `Capped at ${MAX_ACCOUNTS_PER_RUN} accounts this run; ${due.length - batch.length} deferred.`,
    );
  }

  for (const target of batch) {
    const tally = (result.byPlatform[target.platform] ??= {
      attempted: 0,
      written: 0,
      failed: 0,
    });
    result.attempted += 1;
    tally.attempted += 1;

    // Per-account try/catch: this is what makes one failure local. A
    // thrown provider client here would otherwise abandon every account
    // after it, including every account on the OTHER provider.
    try {
      const read = await readOne(target, nowIso, deps);

      if (!read.ok) {
        result.failed += 1;
        tally.failed += 1;
        await persistAccountSnapshotFailure({
          workspaceId: target.workspaceId,
          accountId: target.accountId,
          platform: target.platform,
          source: metricSource(target.platform),
          freshness: read.rateLimited ? "rate_limited" : "provider_error",
          error: read.reason,
          fetchedAtIso: nowIso,
          db: deps.db,
        }).catch(() => ({ recorded: false }));
        continue;
      }

      const persisted = await persistAccountSnapshot({
        workspaceId: target.workspaceId,
        accountId: target.accountId,
        snapshot: read.snapshot,
        db: deps.db,
      });

      if (persisted.canonicalWritten) {
        result.written += 1;
        tally.written += 1;
      } else {
        result.failed += 1;
        tally.failed += 1;
      }
    } catch (err) {
      result.failed += 1;
      tally.failed += 1;
      result.notes.push(`${target.platform}: ${errText(err)}`);
    }
  }

  return result;
}

type ReadOutcome =
  | { ok: true; snapshot: AccountSnapshot }
  | { ok: false; reason: string; rateLimited: boolean };

async function readOne(
  target: SnapshotTarget,
  nowIso: string,
  deps: CollectorDeps,
): Promise<ReadOutcome> {
  if (target.platform === "bluesky") {
    const read = deps.readBluesky ?? fetchBlueskyAccountSnapshot;
    if (!target.handle) {
      return { ok: false, reason: "No Bluesky handle recorded for this identity.", rateLimited: false };
    }
    const out = await read(target.handle, nowIso);
    return out.ok
      ? { ok: true, snapshot: out.snapshot }
      : { ok: false, reason: out.reason, rateLimited: out.rateLimited };
  }

  const read = deps.readX ?? fetchXAccountSnapshot;
  const out = await read({
    db: deps.db,
    workspaceId: target.workspaceId,
    accountId: target.accountId,
    nowIso,
  });
  return out.ok
    ? { ok: true, snapshot: out.snapshot }
    : { ok: false, reason: out.reason, rateLimited: out.rateLimited };
}

/** One entry per account; a workspace publishing ten posts to one
 *  identity must not produce ten profile reads. */
export function dedupeTargets(
  targets: readonly SnapshotTarget[],
): SnapshotTarget[] {
  const seen = new Map<string, SnapshotTarget>();
  for (const target of targets) {
    if (!target.accountId) continue;
    if (!seen.has(target.accountId)) seen.set(target.accountId, target);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.platform.localeCompare(b.platform) || a.accountId.localeCompare(b.accountId),
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}
