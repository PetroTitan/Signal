import "server-only";
/**
 * Phase C2.2 / C2.3 — gather REAL operational counts for the digest.
 *
 * Every number here comes from the same source-of-truth the dashboard
 * and notification feed use (publish_history + execution_items +
 * platform_connections). Nothing is estimated or fabricated — these are
 * pipeline counts, never engagement metrics.
 */

import { countPublishesSince } from "@/repositories/publish-history-repository";
import {
  countExecutionItemsByStatus,
  listExecutionItemsByStatus,
} from "@/repositories/execution-item-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { getNotificationPreferences } from "@/repositories/notification-preferences-repository";
import { isStaleClaim } from "@/core/publishing/execution-claim";
import { isConnectionExpiringSoon, type DigestCounts } from "./notification-builder";

function metaClaimedAt(metadata: Record<string, unknown>): string | null {
  const claim = metadata?.["scheduler_claim"];
  if (claim && typeof claim === "object") {
    const at = (claim as Record<string, unknown>)["claimed_at"];
    if (typeof at === "string") return at;
  }
  return null;
}

/**
 * Real counts for the operational digest over the given window.
 * `periodHours` controls only the "published" tally (a point-in-time
 * count for a window); failed/blocked/retrying/stale/expiring reflect
 * current pending state, which is what the operator needs to act on.
 */
export async function gatherDigestCounts(
  workspaceId: string,
  opts?: { periodHours?: number; userId?: string; now?: Date },
): Promise<DigestCounts> {
  const now = opts?.now ?? new Date();
  const periodHours = opts?.periodHours ?? 24;
  const sinceIso = new Date(now.getTime() - periodHours * 60 * 60 * 1000).toISOString();

  const warningDays = opts?.userId
    ? (await getNotificationPreferences(workspaceId, opts.userId).catch(() => null))
        ?.connectionWarningDays ?? 3
    : 3;

  const [published, failed, blocked, retrying, running, connections] = await Promise.all([
    countPublishesSince(workspaceId, sinceIso),
    countExecutionItemsByStatus(workspaceId, ["failed"]),
    countExecutionItemsByStatus(workspaceId, ["blocked"]),
    countExecutionItemsByStatus(workspaceId, ["scheduled"], { minAttemptCount: 1 }),
    listExecutionItemsByStatus(workspaceId, ["running"], { limit: 100 }),
    listPlatformConnections(workspaceId),
  ]);

  const staleClaims = running.filter((it) =>
    isStaleClaim(metaClaimedAt(it.metadata), now),
  ).length;

  const expiringConnections = connections.filter(
    (c) =>
      c.accountId &&
      isConnectionExpiringSoon({ expiresAtIso: c.expiresAt ?? null, warningDays, now }),
  ).length;

  return { published, failed, blocked, retrying, staleClaims, expiringConnections };
}
