import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { formatMinutes } from "@/core/bluesky-campaigns/campaign-day";
import {
  campaignConservation,
  listCampaigns,
  listLeadLists,
  listSequences,
} from "@/repositories/linkedin-sales-repository";
import { CAMPAIGN_STATUS_LABELS } from "@/core/linkedin-sales/state";
import { CampaignForm } from "./_campaign-form";
import { CampaignControls } from "./_campaign-controls";

export const dynamic = "force-dynamic";

export default async function LinkedInCampaignsPage() {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to run campaigns.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;
  const canEdit = can(membership.role, "edit_content");

  const [campaigns, lists, sequences] = await Promise.all([
    listCampaigns({ workspaceId }),
    listLeadLists({ workspaceId }),
    listSequences({ workspaceId }),
  ]);
  const counts = await Promise.all(campaigns.map((c) => campaignConservation({ workspaceId, campaignId: c.id })));
  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? "—";
  const sequenceName = (id: string) => sequences.find((s) => s.id === id)?.name ?? "—";

  return (
    <div className="space-y-6">
      <section aria-labelledby="campaigns-heading" className="space-y-3">
        <h2 id="campaigns-heading" className="section-title">Campaigns</h2>
        <p className="text-sm text-ink-600 leading-relaxed">
          A campaign pairs a list with a sequence. When you start it, the people in the list are fixed, and Signal
          prepares up to your daily number of tasks inside the working window. You perform each task and mark it.
        </p>
        {campaigns.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600">No campaigns yet.</p>
        ) : (
          <ul className="list-none p-0 m-0 space-y-3">
            {campaigns.map((c, i) => (
              <li key={c.id} className="card card-padded space-y-3">
                <div className="flex flex-wrap gap-x-3 gap-y-1 items-baseline justify-between">
                  <h3 className="font-medium text-ink-900 break-words min-w-0">{c.name}</h3>
                  <span className="badge badge-neutral">{CAMPAIGN_STATUS_LABELS[c.status]}</span>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="stat-label">List</dt><dd className="break-words">{listName(c.lead_list_id)}</dd>
                  <dt className="stat-label">Sequence</dt><dd className="break-words">{sequenceName(c.sequence_id)}</dd>
                  <dt className="stat-label">Window</dt>
                  <dd>{formatMinutes(c.working_window_start_minute)}–{formatMinutes(c.working_window_end_minute)} {c.timezone}</dd>
                  <dt className="stat-label">Tasks per day</dt><dd>{c.daily_task_target} (your workload setting)</dd>
                  <dt className="stat-label">People</dt>
                  <dd>
                    {counts[i].membersTotal} total · {counts[i].waiting} waiting · {counts[i].completed} completed · {counts[i].suppressed} suppressed ·{" "}
                    {counts[i].operatorSkipped} skipped · {counts[i].structurallyInvalid} cannot be prepared · {counts[i].cancelled} cancelled
                  </dd>
                  <dt className="stat-label">Tasks</dt>
                  <dd>{counts[i].tasksOpen} open · {counts[i].tasksConfirmed} operator confirmed · {counts[i].tasksSkipped} skipped · {counts[i].tasksCancelled} cancelled</dd>
                </dl>
                {canEdit ? <CampaignControls campaignId={c.id} status={c.status} name={c.name} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {canEdit ? (
        lists.length > 0 && sequences.length > 0 ? (
          <CampaignForm
            lists={lists.map((l) => ({ id: l.id, name: l.name }))}
            sequences={sequences.map((s) => ({ id: s.id, name: s.name }))}
            defaultTimezone="UTC"
          />
        ) : (
          <p className="card card-padded text-sm text-ink-600">Create a lead list and a sequence first; a campaign needs both.</p>
        )
      ) : (
        <p className="card card-padded text-sm text-ink-600">Your role can view campaigns but not change them.</p>
      )}
    </div>
  );
}
