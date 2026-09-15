import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import {
  getLeadsByIds,
  getMembersByIds,
  listCampaigns,
  listTasksKeyset,
  type TaskCursor,
} from "@/repositories/linkedin-sales-repository";
import { TaskCard } from "./_task-card";

export const dynamic = "force-dynamic";

/**
 * The operator's queue: every task that is ready, opened or copied,
 * oldest first. Keyset paged. Each card is a manual task; nothing on
 * this page happens on LinkedIn.
 */
export default async function LinkedInTasksPage({ searchParams }: { searchParams?: { after?: string; campaign?: string } }) {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to see tasks.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;
  const canEdit = can(membership.role, "edit_content");

  const campaignId = searchParams?.campaign && /^[0-9a-f-]{36}$/i.test(searchParams.campaign) ? searchParams.campaign : null;
  let after: TaskCursor | null = null;
  if (searchParams?.after) {
    const [availableAt, id] = searchParams.after.split("|");
    if (availableAt && id) after = { availableAt, id };
  }

  const [page, campaigns] = await Promise.all([
    listTasksKeyset({ workspaceId, states: ["ready", "opened", "copied"], campaignId, after, pageSize: 20 }),
    listCampaigns({ workspaceId }),
  ]);
  const members = await getMembersByIds({ workspaceId, ids: page.rows.map((t) => t.campaign_member_id) });
  const leads = await getLeadsByIds({ workspaceId, ids: members.map((m) => m.lead_id) });
  const memberById = new Map(members.map((m) => [m.id, m]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name ?? "Campaign";

  const nextHref = page.nextCursor
    ? `/linkedin/tasks?${campaignId ? `campaign=${campaignId}&` : ""}after=${encodeURIComponent(`${page.nextCursor.availableAt}|${page.nextCursor.id}`)}`
    : null;

  return (
    <div className="space-y-6">
      <section aria-labelledby="tasks-heading" className="space-y-3">
        <div className="flex flex-wrap gap-2 items-baseline justify-between">
          <h2 id="tasks-heading" className="section-title">Tasks for you</h2>
          {campaignId ? (
            <Link href="/linkedin/tasks" className="underline text-sm text-signal-800 inline-flex items-center min-h-11">Show every campaign</Link>
          ) : null}
        </div>
        {campaigns.length > 1 && !campaignId ? (
          <nav aria-label="Filter by campaign" className="flex flex-wrap gap-2">
            {campaigns.filter((c) => c.status === "active" || c.status === "paused").map((c) => (
              <Link key={c.id} href={`/linkedin/tasks?campaign=${c.id}`} className="btn-secondary min-h-11">{c.name}</Link>
            ))}
          </nav>
        ) : null}
        {page.rows.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600 leading-relaxed">
            Nothing is waiting for you. Signal prepares tasks inside each running campaign&rsquo;s working window, up to the daily number you set.
          </p>
        ) : (
          <ul className="list-none p-0 m-0 space-y-4">
            {page.rows.map((t) => {
              const member = memberById.get(t.campaign_member_id);
              const lead = member ? leadById.get(member.lead_id) : undefined;
              return (
                <li key={t.id}>
                  <TaskCard
                    task={{
                      id: t.id, kind: t.kind, state: t.state, draftText: t.draft_text, profileUrl: t.profile_url,
                      openedAt: t.opened_at, copiedAt: t.copied_at,
                    }}
                    lead={{
                      name: lead?.customer_provided_name ?? null,
                      company: lead?.customer_provided_company ?? null,
                      title: lead?.customer_provided_title ?? null,
                    }}
                    campaignName={campaignName(t.campaign_id)}
                    canEdit={canEdit}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {nextHref ? <Link href={nextHref} className="btn-secondary min-h-11 w-full sm:w-auto">Load more</Link> : null}
      </section>
    </div>
  );
}
