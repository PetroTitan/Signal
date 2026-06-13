import "server-only";
/**
 * Phase C2.1 / C2.5 — reconcile REAL operational state into the
 * recipient's notification feed.
 *
 * Runs on notification-center load. Reads the same source-of-truth the
 * dashboard "Needs attention" uses (failed/blocked/stale-claim/retry-
 * exhausted execution items + expiring platform connections) and
 * upserts notification rows for the current user. Idempotent via
 * dedupe_key, so repeated loads never duplicate. Best-effort: a write
 * failure is logged, never thrown. Does NOT touch the scheduler.
 */

import {
  listExecutionItemsByStatus,
} from "@/repositories/execution-item-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { listAcceptedInvitationsByInviter } from "@/repositories/invitation-repository";
import { createNotification } from "@/repositories/notification-repository";
import { getNotificationPreferences } from "@/repositories/notification-preferences-repository";
import {
  buildBlockedNotification,
  buildConnectionExpiringNotification,
  buildFailedNotification,
  buildInvitationAcceptedNotification,
  buildStaleClaimNotification,
  isConnectionExpiringSoon,
  type NotificationSpec,
} from "./notification-builder";
import { isStaleClaim } from "@/core/publishing/execution-claim";

function metaStr(m: Record<string, unknown>, path: string[]): string | null {
  let cur: unknown = m;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return null;
  }
  return typeof cur === "string" ? cur : null;
}
function metaBool(m: Record<string, unknown>, path: string[]): boolean {
  let cur: unknown = m;
  for (const k of path) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
    else return false;
  }
  return cur === true;
}
function platformLabel(p: string | null): string {
  return p === "reddit" ? "Reddit" : p === "linkedin" ? "LinkedIn" : p === "x" ? "X" : p ?? "Platform";
}

/**
 * Reconcile current operational state into notifications for `userId`.
 * Returns the number of specs written (best-effort).
 */
export async function syncOperationalNotifications(input: {
  workspaceId: string;
  userId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const prefs = await getNotificationPreferences(input.workspaceId, input.userId).catch(
    () => null,
  );
  const warningDays = prefs?.connectionWarningDays ?? 3;

  const specs: NotificationSpec[] = [];
  try {
    const [failed, blocked, running, connections] = await Promise.all([
      listExecutionItemsByStatus(input.workspaceId, ["failed"], { limit: 25 }),
      listExecutionItemsByStatus(input.workspaceId, ["blocked"], { limit: 25 }),
      listExecutionItemsByStatus(input.workspaceId, ["running"], { limit: 25 }),
      listPlatformConnections(input.workspaceId),
    ]);

    for (const it of failed) {
      const target = metaStr(it.metadata, ["target"]);
      specs.push(
        buildFailedNotification({
          executionItemId: it.id,
          where: target ? `r/${target}` : platformLabel(it.platform),
          retryExhausted: metaBool(it.metadata, ["retry", "exhausted"]),
        }),
      );
    }
    for (const it of blocked) {
      specs.push(
        buildBlockedNotification({
          executionItemId: it.id,
          title: it.title,
          reasonCode: metaStr(it.metadata, ["publish_outcome", "reason_code"]),
        }),
      );
    }
    for (const it of running) {
      if (isStaleClaim(metaStr(it.metadata, ["scheduler_claim", "claimed_at"]), now)) {
        specs.push(buildStaleClaimNotification({ executionItemId: it.id, title: it.title }));
      }
    }
    for (const c of connections) {
      if (!c.accountId) continue;
      if (
        isConnectionExpiringSoon({ expiresAtIso: c.expiresAt ?? null, warningDays, now })
      ) {
        specs.push(
          buildConnectionExpiringNotification({
            connectionId: c.id,
            platformLabel: platformLabel(c.platform),
            expiresAtIso: c.expiresAt ?? null,
          }),
        );
      }
    }

    // invitation_accepted — for invites THIS user sent that are now
    // accepted. RLS restricts the read to owner/admin, so a non-inviter
    // simply gets no rows. Deduped per invitation.
    const acceptedInvites = await listAcceptedInvitationsByInviter(
      input.workspaceId,
      input.userId,
    ).catch(() => []);
    for (const inv of acceptedInvites) {
      specs.push(
        buildInvitationAcceptedNotification({ invitationId: inv.id, email: inv.email }),
      );
    }
  } catch (err) {
    console.error("[sync-notifications] source read failed", err);
    return;
  }

  for (const spec of specs) {
    try {
      await createNotification({
        workspaceId: input.workspaceId,
        userId: input.userId,
        type: spec.type,
        title: spec.title,
        body: spec.body,
        entityType: spec.entityType,
        entityId: spec.entityId,
        dedupeKey: spec.dedupeKey,
      });
    } catch (err) {
      console.error("[sync-notifications] write failed (non-fatal)", spec.dedupeKey, err);
    }
  }
}
