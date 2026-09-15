import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { campaignConservation, countTasksByState, listCampaigns } from "@/repositories/linkedin-sales-repository";
import { CAMPAIGN_STATUS_LABELS, TASK_STATE_LABELS } from "@/core/linkedin-sales/state";
import type { LinkedInTaskState } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

const STATES: LinkedInTaskState[] = ["scheduled", "ready", "opened", "copied", "operator_confirmed", "skipped", "cancelled"];

/**
 * Counts, and only counts. Every figure is what the operator did or
 * what Signal prepared. There is no reply rate, acceptance rate or
 * response metric, because Signal cannot observe LinkedIn.
 */
export default async function LinkedInAnalyticsPage() {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to see analytics.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;

  const [tasks, campaigns] = await Promise.all([countTasksByState({ workspaceId }), listCampaigns({ workspaceId })]);
  const counts = await Promise.all(campaigns.map((c) => campaignConservation({ workspaceId, campaignId: c.id })));

  return (
    <div className="space-y-6">
      <section aria-labelledby="task-counts-heading" className="card card-padded space-y-3">
        <h2 id="task-counts-heading" className="section-title">Tasks in this workspace</h2>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
          {STATES.map((s) => (
            <div key={s}>
              <dt className="stat-label">{TASK_STATE_LABELS[s]}</dt>
              <dd className="stat-value">{tasks[s].toLocaleString("en-GB")}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-ink-600 leading-relaxed">
          &ldquo;Operator confirmed&rdquo; is your own statement that you did the step. Signal has no way to observe what happened on
          LinkedIn and shows no acceptance, reply or response figures.
        </p>
      </section>

      <section aria-labelledby="per-campaign-heading" className="space-y-3">
        <h2 id="per-campaign-heading" className="section-title">Per campaign</h2>
        {campaigns.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600">No campaigns yet.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">Every person in every campaign ends in exactly one state; the columns add up to the total.</caption>
              <thead>
                <tr className="text-left text-ink-600">
                  <th scope="col" className="p-3 font-medium">Campaign</th>
                  <th scope="col" className="p-3 font-medium">Status</th>
                  <th scope="col" className="p-3 font-medium">People</th>
                  <th scope="col" className="p-3 font-medium">Waiting</th>
                  <th scope="col" className="p-3 font-medium">Completed</th>
                  <th scope="col" className="p-3 font-medium">Suppressed</th>
                  <th scope="col" className="p-3 font-medium">Skipped by you</th>
                  <th scope="col" className="p-3 font-medium">Cannot be prepared</th>
                  <th scope="col" className="p-3 font-medium">Cancelled</th>
                  <th scope="col" className="p-3 font-medium">Open tasks</th>
                  <th scope="col" className="p-3 font-medium">Operator confirmed</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c, i) => (
                  <tr key={c.id} className="border-t border-ink-100">
                    <th scope="row" className="p-3 font-medium text-ink-900 break-words text-left">{c.name}</th>
                    <td className="p-3">{CAMPAIGN_STATUS_LABELS[c.status]}</td>
                    <td className="p-3">{counts[i].membersTotal}</td>
                    <td className="p-3">{counts[i].waiting}</td>
                    <td className="p-3">{counts[i].completed}</td>
                    <td className="p-3">{counts[i].suppressed}</td>
                    <td className="p-3">{counts[i].operatorSkipped}</td>
                    <td className="p-3">{counts[i].structurallyInvalid}</td>
                    <td className="p-3">{counts[i].cancelled}</td>
                    <td className="p-3">{counts[i].tasksOpen}</td>
                    <td className="p-3">{counts[i].tasksConfirmed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
