import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getImportJob } from "@/repositories/linkedin-sales-repository";
import { importErrorReportCsv } from "@/core/linkedin-sales/import-report";

/**
 * The error report of one import job, as a CSV download.
 *
 * Any workspace member may read it (the same rule as reading the job).
 * The report holds row numbers, the offending values as the operator
 * typed them (truncated) and the reason — nothing fetched from anywhere.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: { jobId: string } }) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });

  const membership = await getPrimaryWorkspace();
  if (!membership) return NextResponse.json({ ok: false, error: "No workspace found." }, { status: 403 });

  const jobId = params.jobId?.trim();
  if (!jobId) return NextResponse.json({ ok: false, error: "Missing import job id." }, { status: 400 });

  const job = await getImportJob({ workspaceId: membership.workspace.id, jobId });
  if (!job) return NextResponse.json({ ok: false, error: "Import not found." }, { status: 404 });

  const csv = importErrorReportCsv(job);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="import-${job.id}-errors.csv"`,
      "cache-control": "no-store",
    },
  });
}
