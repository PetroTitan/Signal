import { NextResponse } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import {
  isLinkedInSchedulerDisabled,
  prepareManualTasks,
  tickDeadlineMs,
} from "@/core/linkedin-sales/scheduler.server";

/**
 * LinkedIn Sales — task preparation tick.
 *
 * Called by Vercel Cron (at-least-once; overlapping calls are safe).
 * Gated by the same shared secret as every other cron route. Uses the
 * service-role client ONLY to prepare internal manual tasks; the
 * database grants that role no way to confirm, skip, open or copy a
 * task, and this route never contacts LinkedIn.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  if (isLinkedInSchedulerDisabled()) {
    return NextResponse.json({
      ok: true,
      disabled: true,
      reason: "LINKEDIN_SALES_DISABLED is set for this deployment. No campaign was considered.",
    });
  }

  const db = createSupabaseServiceRoleClient();
  if (!db) {
    return NextResponse.json(
      { ok: false, error: "Task preparation is not configured: SUPABASE_SERVICE_ROLE_KEY is missing." },
      { status: 503 },
    );
  }

  try {
    const round = await prepareManualTasks({ db, deadlineMs: tickDeadlineMs(process.env) });
    return NextResponse.json({ ok: true, ...round });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Task preparation failed." },
      { status: 500 },
    );
  }
}
