import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  campaignConservation,
  countLeads,
  countTasksByState,
  listCampaigns,
} from "@/repositories/linkedin-sales-repository";
import { CAMPAIGN_STATUS_LABELS } from "@/core/linkedin-sales/state";

export const dynamic = "force-dynamic";

/**
 * The overview answers the operator's questions in order:
 * what is ready for me, what have I done, what is Signal preparing,
 * and what cannot be prepared. Every number is a database count.
 */
export default async function LinkedInOverviewPage() {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to use the LinkedIn Sales workspace.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;

  const [tasks, leads, campaigns] = await Promise.all([
    countTasksByState({ workspaceId }),
    countLeads({ workspaceId }),
    listCampaigns({ workspaceId, statuses: ["active", "paused"] }),
  ]);
  const readyForMe = tasks.ready + tasks.opened + tasks.copied;
  const conservation = await Promise.all(
    campaigns.slice(0, 20).map(async (c) => ({ campaign: c, counts: await campaignConservation({ workspaceId, campaignId: c.id }) })),
  );
  const blocked = conservation.reduce((n, x) => n + x.counts.structurallyInvalid, 0);
  const suppressed = conservation.reduce((n, x) => n + x.counts.suppressed, 0);
  const waiting = conservation.reduce((n, x) => n + x.counts.waiting, 0);

  return (
    <div className="space-y-6">
      <section aria-labelledby="ready-heading" className="card card-padded space-y-3">
        <h2 id="ready-heading" className="section-title">What is ready for me?</h2>
        <p className="stat-value">{readyForMe.toLocaleString("en-GB")}</p>
        <p className="text-sm text-ink-600 leading-relaxed">
          {readyForMe === 0
            ? "No tasks are waiting for you right now. Signal prepares new ones inside each campaign's working window."
            : `${tasks.ready.toLocaleString("en-GB")} not started, ${tasks.opened.toLocaleString("en-GB")} with the profile opened, ${tasks.copied.toLocaleString("en-GB")} with the draft copied. Each one is finished only when you mark it completed.`}
        </p>
        <Link href="/linkedin/tasks" className="btn-nav min-h-11 w-full sm:w-auto">Go to tasks</Link>
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <section aria-labelledby="done-heading" className="card card-padded space-y-2">
          <h2 id="done-heading" className="section-title">What have I confirmed?</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="stat-label">Operator confirmed</dt>
            <dd className="text-ink-900 font-medium">{tasks.operator_confirmed.toLocaleString("en-GB")}</dd>
            <dt className="stat-label">Skipped by you</dt>
            <dd className="text-ink-900 font-medium">{tasks.skipped.toLocaleString("en-GB")}</dd>
            <dt className="stat-label">Cancelled</dt>
            <dd className="text-ink-900 font-medium">{tasks.cancelled.toLocaleString("en-GB")}</dd>
          </dl>
          <p className="text-sm text-ink-600 leading-relaxed">
            &ldquo;Confirmed&rdquo; means you told Signal you did it. Signal cannot see LinkedIn and does not claim to.
          </p>
        </section>

        <section aria-labelledby="preparing-heading" className="card card-padded space-y-2">
          <h2 id="preparing-heading" className="section-title">What is Signal preparing?</h2>
          {campaigns.length === 0 ? (
            <p className="text-sm text-ink-600 leading-relaxed">No campaign is running. Start one from Campaigns once you have a list and a sequence.</p>
          ) : (
            <ul className="list-none p-0 m-0 space-y-2 text-sm">
              {campaigns.slice(0, 20).map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2 gap-y-1 justify-between">
                  <span className="min-w-0 break-words font-medium text-ink-900">{c.name}</span>
                  <span className="text-ink-600">{CAMPAIGN_STATUS_LABELS[c.status]} · up to {c.daily_task_target}/day · {c.timezone}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-ink-600 leading-relaxed">{waiting.toLocaleString("en-GB")} people are waiting for a next step across running campaigns.</p>
          <Link href="/linkedin/campaigns" className="underline text-sm text-signal-800 inline-flex items-center min-h-11">Manage campaigns</Link>
        </section>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <section aria-labelledby="blocked-heading" className="card card-padded space-y-2">
          <h2 id="blocked-heading" className="section-title">What cannot be prepared?</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="stat-label">Suppressed people</dt>
            <dd className="text-ink-900 font-medium">{suppressed.toLocaleString("en-GB")}</dd>
            <dt className="stat-label">Sequence problems</dt>
            <dd className="text-ink-900 font-medium">{blocked.toLocaleString("en-GB")}</dd>
          </dl>
          <p className="text-sm text-ink-600 leading-relaxed">
            Suppressed people are never prepared, in any campaign. Sequence problems name the step that is wrong; nothing was guessed.
          </p>
          <Link href="/linkedin/analytics" className="underline text-sm text-signal-800 inline-flex items-center min-h-11">See every campaign&rsquo;s counts</Link>
        </section>

        <section aria-labelledby="leads-heading" className="card card-padded space-y-2">
          <h2 id="leads-heading" className="section-title">Who is in my lists?</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="stat-label">Leads stored</dt>
            <dd className="text-ink-900 font-medium">{leads.total.toLocaleString("en-GB")}</dd>
            <dt className="stat-label">Marked do-not-contact</dt>
            <dd className="text-ink-900 font-medium">{leads.doNotContact.toLocaleString("en-GB")}</dd>
          </dl>
          <p className="text-sm text-ink-600 leading-relaxed">Only what your organisation provided: a public profile URL and, if you gave them, a name, company and title.</p>
          <Link href="/linkedin/leads" className="underline text-sm text-signal-800 inline-flex items-center min-h-11">Import or review leads</Link>
        </section>
      </div>
    </div>
  );
}
