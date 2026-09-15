import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { normaliseProfileUrl, REFUSAL_LABELS } from "@/core/linkedin-sales/profile-url";
import { exportProfileData } from "@/repositories/linkedin-sales-repository";

/**
 * Everything Signal holds about one public profile, as a JSON download.
 * Owner/admin/editor. The export itself is recorded as a compliance
 * event by the database function.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });
  const membership = await getPrimaryWorkspace();
  if (!membership) return NextResponse.json({ ok: false, error: "No workspace found." }, { status: 403 });
  if (!can(membership.role, "edit_content")) {
    return NextResponse.json({ ok: false, error: "Your role cannot export profile data." }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get("profile") ?? "";
  const key = normaliseProfileUrl(raw);
  if (!key.ok) return NextResponse.json({ ok: false, error: REFUSAL_LABELS[key.reason] }, { status: 400 });

  const data = await exportProfileData({ workspaceId: membership.workspace.id, profileKey: key.profileKey });
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="linkedin-profile-${key.profileKey.slice(0, 60)}.json"`,
      "cache-control": "no-store",
    },
  });
}
