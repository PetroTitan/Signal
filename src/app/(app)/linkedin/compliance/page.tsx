import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { LINKEDIN_CAPABILITIES } from "@/core/linkedin-sales/capabilities";

export const dynamic = "force-dynamic";

const STATUS_LABELS = {
  unavailable: "Not available",
  manual_only: "You do it yourself",
  official_api_approved: "Official API, approved scopes",
} as const;

/**
 * What Signal can and cannot do with LinkedIn, from the capability
 * registry — the same table the code consults. Nothing here is
 * configurable: a capability changes status only by a code change with
 * evidence, never by a setting.
 */
export default async function LinkedInCompliancePage() {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to view the compliance page.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;

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
    </div>
  );
}
