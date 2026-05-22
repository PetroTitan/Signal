import { NextResponse } from "next/server";
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
 * POST /api/oauth/:platform/disconnect
 *
 * Body: { account_id?: string, connection_id?: string }
 *
 * Marks the connection `revoked` and clears the encrypted token
 * columns. Best-effort: providers without a documented revocation
 * endpoint just have their local record cleared.
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

    const conn = accountId
      ? await getConnectionForAccount(ctx.workspaceId, accountId, ctx.platform)
      : null;

    if (!conn) {
      return NextResponse.json(
        { ok: false, code: "not_found", error: "Connection not found." },
        { status: 404 },
      );
    }

    const updated = await markConnectionStatus({
      workspaceId: ctx.workspaceId,
      connectionId: conn.id,
      status: "revoked",
      healthStatus: "revoked",
      message: "Operator disconnected the account.",
    });

    try {
      await recordActivity({
        workspaceId: ctx.workspaceId,
        eventType: "platform_connection.disconnected",
        entityType: "platform_connection",
        entityId: updated.id,
        title: `${ctx.platform} disconnected`,
        description: null,
      });
    } catch (err) {
      console.error("[oauth/disconnect] activity log failed", err);
    }

    return NextResponse.json({ ok: true, connectionId: updated.id });
  } catch (err) {
    return oauthJsonError(err);
  }
}
