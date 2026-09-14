import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getCampaign } from "@/repositories/bluesky-campaign-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Export one unfollow campaign's results as CSV.
 *
 * STREAMED BY KEYSET, NEVER BUFFERED. A campaign may hold 100,000
 * members; building the whole file in memory would be a reliable way to
 * turn a successful campaign into a failed export. Rows are read a page
 * at a time, ordered by `import_sequence` — there is no OFFSET, so the
 * last page costs what the first did.
 *
 * AUTHORIZATION IS THE USER'S OWN SESSION. This route deliberately does
 * NOT use the service role: it reads through the signed-in user's
 * client, so RLS applies and a member of another workspace gets
 * nothing, whatever campaign id they put in the query string. The
 * explicit workspace filter is belt and braces on top of that.
 *
 * NO CREDENTIALS ARE EXPORTED. The columns are the member's public
 * identity, its outcome, the record key that was deleted and the
 * provider's own error message. No token, header or session value
 * exists in any of them.
 */

const PAGE = 500;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const campaignId = url.searchParams.get("campaign") ?? "";
  if (!campaignId) {
    return NextResponse.json(
      { ok: false, error: "No campaign specified." },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return NextResponse.json(
      { ok: false, error: "No workspace found." },
      { status: 403 },
    );
  }

  const campaign = await getCampaign(membership.workspace.id, campaignId);
  if (!campaign || campaign.kind !== "unfollow") {
    return NextResponse.json(
      { ok: false, error: "That campaign is not in your workspace." },
      { status: 404 },
    );
  }

  const header = [
    "subject_did",
    "handle",
    "outcome",
    "protected_reason",
    "deleted_record_rkey",
    "record_source",
    "attempts",
    "last_error",
    "finished_at",
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${header.join(",")}\n`));
      let after = 0;
      for (;;) {
        const { data, error } = await supabase
          .from("bluesky_follow_campaign_members")
          .select(
            "subject_did, current_handle, status, protected_reason, provider_record_rkey, provider_record_source, attempt_count, last_error_message, completed_at, import_sequence",
          )
          .eq("workspace_id", membership.workspace.id)
          .eq("campaign_id", campaignId)
          .gt("import_sequence", after)
          .order("import_sequence", { ascending: true })
          .limit(PAGE);

        if (error) {
          // The file ends with a visible marker rather than silently
          // truncating: a short CSV that looks complete is worse than
          // one that says it is not.
          controller.enqueue(
            encoder.encode(`# export stopped early: ${csvCell(error.message)}\n`),
          );
          break;
        }
        const rows = (data ?? []) as unknown as Record<string, unknown>[];
        if (rows.length === 0) break;

        for (const row of rows) {
          controller.enqueue(
            encoder.encode(
              [
                csvCell(row.subject_did),
                csvCell(row.current_handle),
                csvCell(row.status),
                csvCell(row.protected_reason),
                csvCell(row.provider_record_rkey),
                csvCell(row.provider_record_source),
                csvCell(row.attempt_count),
                csvCell(row.last_error_message),
                csvCell(row.completed_at),
              ].join(",") + "\n",
            ),
          );
        }
        after = Number(rows[rows.length - 1].import_sequence ?? after);
        if (rows.length < PAGE) break;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="unfollow-${campaignId}.csv"`,
      "cache-control": "no-store",
    },
  });
}
