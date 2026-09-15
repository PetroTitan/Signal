import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { loadUnfollowCampaignDetail } from "@/core/bluesky-unfollow/load-detail.server";
import { UnfollowCampaignDetailView } from "./_detail-view";

export const dynamic = "force-dynamic";

/**
 * One unfollow campaign, in full: `/relationships/unfollow/[id]`.
 *
 * The whole surface is a pure function of the URL — which campaign,
 * which profile filter, and two keyset cursors (`after` for profiles,
 * `runs_before` for runs). Every number comes from an exact count or a
 * run row; the frozen queue is never loaded to draw it.
 *
 * Authorization: the workspace comes from the signed-in session, never
 * from the URL; a campaign outside it is a 404. Every control on the
 * page is a server action that re-checks membership and role itself.
 */

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <Topbar title={title} description="Automatic unfollowing" />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">{children}</div>
    </>
  );
}

export default async function UnfollowCampaignPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { after?: string; status?: string; runs_before?: string };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Shell title="Unfollow campaign">
        <div className="card card-padded">
          <p className="text-sm text-ink-600">Connect Supabase first.</p>
        </div>
      </Shell>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) notFound();

  const after = Number(searchParams?.after);
  const runsBefore = searchParams?.runs_before ?? null;
  const detail = await loadUnfollowCampaignDetail({
    workspaceId: membership.workspace.id,
    campaignId: params.id,
    afterSequence: Number.isFinite(after) && after > 0 ? Math.floor(after) : null,
    statusFilter: searchParams?.status ?? null,
    runsBefore: runsBefore && /^\d{4}-\d{2}-\d{2}$/.test(runsBefore) ? runsBefore : null,
  });
  if (!detail) notFound();

  const canManage = can(membership.role, "connect_platforms");

  return (
    <Shell title={detail.name}>
      <UnfollowCampaignDetailView detail={detail} canManage={canManage} />
    </Shell>
  );
}
