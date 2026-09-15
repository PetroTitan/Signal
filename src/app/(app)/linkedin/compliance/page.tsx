import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { LINKEDIN_CAPABILITIES } from "@/core/linkedin-sales/capabilities";
import {
  countExpiredLeads,
  listComplianceEventsKeyset,
  listSuppression,
  type EventCursor,
} from "@/repositories/linkedin-sales-repository";
import { SuppressionPanel } from "./_suppression-panel";
import { DataTools } from "./_data-tools";

export const dynamic = "force-dynamic";

const STATUS_LABELS = {
  unavailable: "Not available",
  manual_only: "You do it yourself",
  official_api_approved: "Official API, approved scopes",
} as const;

const EVENT_LABELS: Record<string, string> = {
  import: "Leads imported",
  suppression_added: "Added to suppression list",
  suppression_removed: "Removed from suppression list",
  export: "Profile data exported",
  deletion: "Profile data deleted",
  operator_confirmation: "Task confirmed by operator",
  task_skipped: "Task skipped by operator",
  task_opened: "Profile opened by operator",
  task_copied: "Draft copied by operator",
  campaign_activated: "Campaign started",
  campaign_paused: "Campaign paused",
  campaign_resumed: "Campaign resumed",
  campaign_cancelled: "Campaign cancelled",
  retention_purge: "Retention purge",
};

/**
 * What Signal can and cannot do with LinkedIn (the registry the code
 * consults), the suppression list, the data tools, and the append-only
 * audit history. Nothing here is configurable: a capability changes
 * status only by a code change with evidence, never by a setting.
 */
export default async function LinkedInCompliancePage({ searchParams }: { searchParams?: { before?: string } }) {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to view the compliance page.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;
  const canEdit = can(membership.role, "edit_content");
  const canDelete = can(membership.role, "manage_settings");

  let before: EventCursor | null = null;
  if (searchParams?.before) {
    const [createdAt, id] = searchParams.before.split("|");
    if (createdAt && id) before = { createdAt, id };
  }
  const today = new Date().toISOString().slice(0, 10);
  const [suppression, events, expired] = await Promise.all([
    listSuppression({ workspaceId, limit: 200 }),
    listComplianceEventsKeyset({ workspaceId, before, pageSize: 50 }),
    countExpiredLeads({ workspaceId, today }),
  ]);

  return (
    <div className="space-y-6">
      <section aria-labelledby="capabilities-heading" className="space-y-3">
        <h2 id="capabilities-heading" className="section-title">What Signal can and cannot do with LinkedIn</h2>
        <p className="text-sm text-ink-600 leading-relaxed">
          Every LinkedIn member action is yours to perform. Signal&rsquo;s installed LinkedIn application is granted only
          sign-in scopes, and LinkedIn publishes no API for messaging, connection requests or member search that Signal could
          use. This table is the registry the code checks; it fails closed for anything not listed as an approved official API.
        </p>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm">
            <caption className="sr-only">Capability registry</caption>
            <thead>
              <tr className="text-left text-ink-600">
                <th scope="col" className="p-3 font-medium">Capability</th>
                <th scope="col" className="p-3 font-medium">Status</th>
                <th scope="col" className="p-3 font-medium">Requires</th>
                <th scope="col" className="p-3 font-medium">Last verified</th>
                <th scope="col" className="p-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {LINKEDIN_CAPABILITIES.map((c) => (
                <tr key={c.name} className="border-t border-ink-100 align-top">
                  <th scope="row" className="p-3 font-medium text-ink-900 text-left">{c.title}</th>
                  <td className="p-3">
                    <span className={"badge " + (c.status === "official_api_approved" ? "badge-info" : c.status === "manual_only" ? "badge-neutral" : "badge-high")}>
                      {STATUS_LABELS[c.status]}
                    </span>
                  </td>
                  <td className="p-3 break-words">
                    {c.requiredProduct ?? "—"}
                    {c.requiredScopes.length > 0 ? <span className="block text-ink-600">Scopes: {c.requiredScopes.join(", ")}</span> : null}
                  </td>
                  <td className="p-3 whitespace-nowrap">{c.lastVerified}</td>
                  <td className="p-3 break-words leading-relaxed">
                    {c.explanation}
                    <span className="block text-ink-600 mt-1 break-all">Evidence: {c.evidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="suppression-heading" className="space-y-3">
        <h2 id="suppression-heading" className="section-title">Suppression list</h2>
        <p className="text-sm text-ink-600 leading-relaxed">
          People on this list are never prepared as a task, in any campaign, from any list — including lists imported later.
          Adding someone ends their waiting steps and cancels their open tasks now.
        </p>
        <SuppressionPanel entries={suppression.map((s) => ({ id: s.id, profileKey: s.profile_key, url: s.canonical_profile_url, reason: s.reason, source: s.source, createdAt: s.created_at }))} canEdit={canEdit} />
      </section>

      <section aria-labelledby="data-tools-heading" className="space-y-3">
        <h2 id="data-tools-heading" className="section-title">Data requests and retention</h2>
        <DataTools canEdit={canEdit} canDelete={canDelete} expiredCount={expired} today={today} />
      </section>

      <section aria-labelledby="events-heading" className="space-y-3">
        <h2 id="events-heading" className="section-title">Audit history</h2>
        <p className="text-sm text-ink-600 leading-relaxed">
          Append-only. Every import, confirmation, skip, suppression change, export, deletion and campaign change is recorded
          with who did it. Nothing here can be edited or removed, by anyone, including administrators.
        </p>
        {events.rows.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600">No events yet.</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">Compliance events, newest first</caption>
              <thead>
                <tr className="text-left text-ink-600">
                  <th scope="col" className="p-3 font-medium">When</th>
                  <th scope="col" className="p-3 font-medium">Event</th>
                  <th scope="col" className="p-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {events.rows.map((e) => (
                  <tr key={e.id} className="border-t border-ink-100 align-top">
                    <td className="p-3 whitespace-nowrap">{new Date(e.created_at).toLocaleString("en-GB")}</td>
                    <td className="p-3">{EVENT_LABELS[e.event_type] ?? e.event_type}</td>
                    <td className="p-3 break-all text-ink-600">
                      {Object.entries(e.details ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {events.nextCursor ? (
          <Link
            href={`/linkedin/compliance?before=${encodeURIComponent(`${events.nextCursor.createdAt}|${events.nextCursor.id}`)}`}
            className="btn-secondary min-h-11 w-full sm:w-auto"
          >
            Older events
          </Link>
        ) : null}
      </section>
    </div>
  );
}
