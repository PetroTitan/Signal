import { NextResponse } from "next/server";
import { evaluateConnectionHealth } from "@/core/platform-oauth";
import {
  oauthJsonError,
  resolveAuthenticatedContext,
} from "../../_helpers";
import {
  getConnectionForAccount,
  markConnectionStatus,
} from "@/repositories/platform-connection-repository";
import { recordActivity } from "@/repositories/activity-repository";

/**
 * POST /api/oauth/:platform/health
 *
 * Body: { account_id: string }
 *
 * Re-evaluates the connection's health from local state and updates
 * the `health_status` + `last_checked_at` columns. Phase E3 does
 * not call the provider's profile endpoint over the network — that
 * extension lives behind the same gate as token storage.
 */
export async function POST(
  request: Request,
  { params }: { params: { platform: string } },
) {
  try {
    const ctx = await resolveAuthenticatedContext(params.platform);
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);
    const accountId =
      typeof body.account_id === "string" ? body.account_id : null;
    if (!accountId) {
      return NextResponse.json(
        { ok: false, code: "validation_failed", error: "account_id is required." },
        { status: 400 },
      );
    }

    const conn = await getConnectionForAccount(
      ctx.workspaceId,
      accountId,
      ctx.platform,
    );
    if (!conn) {
      return NextResponse.json(
        { ok: false, code: "not_found", error: "Connection not found." },
        { status: 404 },
      );
    }

    const verdict = evaluateConnectionHealth(conn);
    const updated = await markConnectionStatus({
      workspaceId: ctx.workspaceId,
      connectionId: conn.id,
      status: verdict.connectionStatus,
      healthStatus: verdict.status,
      message: verdict.message,
    });

    try {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "platform_connection.health_checked",
        entityType: "platform_connection",
        entityId: updated.id,
        title: `${ctx.platform} health: ${verdict.status}`,
        description: verdict.message,
      });
    } catch (err) {
      console.error("[oauth/health] activity log failed", err);
    }

    return NextResponse.json({
      ok: true,
      connectionId: updated.id,
      health: verdict.status,
      connectionStatus: verdict.connectionStatus,
      message: verdict.message,
    });
  } catch (err) {
    return oauthJsonError(err);
  }
}
