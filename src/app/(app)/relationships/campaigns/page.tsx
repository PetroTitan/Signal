import { Topbar } from "@/components/topbar";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadCampaigns } from "@/core/bluesky-campaigns/load-campaigns.server";
import { ReadFailureNotice } from "../_read-failure-notice";
import { CampaignUi } from "./_campaign-ui";
import { CreateCampaignForm } from "./_create-form";
import type { BlueskyCampaignMemberStatus } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * Relationship campaigns — follow AND unfollow, in one list with the
 * kind on every entry, and a filter for each.
 *
 * An unfollow campaign is never described as a follow campaign and is
 * never rendered inside the follow detail: `?campaign=<unfollow id>`
 * redirects to that campaign's own screen. Before this, the page listed
 * every campaign under "Follow campaigns" and drew its create form
 * beneath an unfollow campaign — which is what production opened.
 *
 * Read-only on the server: every mutation is a server action with its
 * own authorization gate. Nothing on this page trusts a workspace id,
 * an identity id, a count or a quota from the client.
 *
 * A campaign queue may hold 100,000+ profiles. This page reads the
 * campaign row, eleven index-only counts, one page of at most 50
 * members and one page of runs — never the queue.
 */

const MEMBER_STATUSES = new Set<BlueskyCampaignMemberStatus>([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "already_following",
  "protected",
  "skipped",
  "retryable",
  "failed_structural",
  "cancelled",
]);

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: {
    campaign?: string;
    kind?: string;
    mpage?: string;
    rpage?: string;
    mstatus?: string;
  };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Campaigns"
          description="Follow or unfollow whole lists on a daily schedule."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">
              Connect Supabase to manage campaigns.
            </p>
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Campaigns" description="Follow or unfollow whole lists on a daily schedule." />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">No workspace found.</p>
          </div>
        </div>
      </>
    );
  }

  const parsePage = (raw: string | undefined) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  };
  const status = searchParams?.mstatus as BlueskyCampaignMemberStatus | undefined;

  const kind =
    searchParams?.kind === "follow" || searchParams?.kind === "unfollow"
      ? searchParams.kind
      : "all";
  const view = await loadCampaigns({
    workspaceId: membership.workspace.id,
    campaignId: searchParams?.campaign ?? null,
    kind,
    memberPage: parsePage(searchParams?.mpage),
    runPage: parsePage(searchParams?.rpage),
    memberStatus: status && MEMBER_STATUSES.has(status) ? status : null,
  });
  if (view.redirectTo) redirect(view.redirectTo);

  return (
    <>
      <Topbar
        title="Campaigns"
        description="Follow campaigns add relationships; unfollow campaigns remove them. Each runs on a daily schedule you approve, and each is labelled with what it does."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-4">
        <p className="text-sm text-ink-600 leading-relaxed">
          <Link href="/relationships" className="nav-link">
            ← Back to relationships
          </Link>
        </p>

        {view.failure ? (
          // Rendered INSTEAD of the lists: an empty campaign list beside
          // a failed read looks like "you have no campaigns".
          <ReadFailureNotice failure={view.failure} />
        ) : (
          <>
            <CampaignUi
              identities={view.identities}
              campaigns={view.campaigns}
              kindFilter={view.kindFilter}
              detail={view.selected}
              killSwitches={view.killSwitches}
            />
            {view.identities.length > 0 && view.kindFilter !== "unfollow" ? (
              <CreateCampaignForm identities={view.identities} />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
