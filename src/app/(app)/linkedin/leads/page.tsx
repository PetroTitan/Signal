import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import {
  countLeads,
  getLeadList,
  listImportJobs,
  listLeadLists,
  listLeadsKeyset,
  type LeadCursor,
} from "@/repositories/linkedin-sales-repository";
import { SOURCE_TYPE_LABELS } from "@/core/linkedin-sales/state";
import { LeadListForm } from "./_lead-list-form";
import { ImportForm } from "./_import-form";

export const dynamic = "force-dynamic";

/**
 * Lead lists and the people in them. A list may hold 10,000 rows; the
 * table pages by keyset ("Load more"), never by numbered page, and the
 * import file never reaches this component.
 */
export default async function LinkedInLeadsPage({ searchParams }: { searchParams?: { list?: string; after?: string } }) {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to import leads.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;
  const canEdit = can(membership.role, "edit_content");

  const lists = await listLeadLists({ workspaceId });
  const counts = await Promise.all(lists.map((l) => countLeads({ workspaceId, leadListId: l.id })));
  const selectedId = searchParams?.list && /^[0-9a-f-]{36}$/i.test(searchParams.list) ? searchParams.list : null;
  const selected = selectedId ? await getLeadList({ workspaceId, leadListId: selectedId }) : null;

  let after: LeadCursor | null = null;
  if (searchParams?.after) {
    const [createdAt, id] = searchParams.after.split("|");
    if (createdAt && id) after = { createdAt, id };
  }
  const page = selected ? await listLeadsKeyset({ workspaceId, leadListId: selected.id, after }) : null;
  const jobs = selected ? await listImportJobs({ workspaceId, leadListId: selected.id }) : [];

  return (
    <div className="space-y-6">
      <section aria-labelledby="lists-heading" className="space-y-3">
        <h2 id="lists-heading" className="section-title">Lead lists</h2>
        {lists.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600 leading-relaxed">
            No lists yet. Create one, then import the profile URLs your organisation already has.
          </p>
        ) : (
          <ul className="list-none p-0 m-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {lists.map((l, i) => (
              <li key={l.id} className="card card-padded space-y-1">
                <Link
                  href={`/linkedin/leads?list=${l.id}`}
                  aria-current={selected?.id === l.id ? "true" : undefined}
                  className={"inline-flex items-center min-h-11 text-sm font-medium underline break-words " + (selected?.id === l.id ? "text-signal-800" : "text-ink-900")}
                >
                  {l.name}
                </Link>
                <p className="text-sm text-ink-600">{SOURCE_TYPE_LABELS[l.source_type]}</p>
                <p className="text-sm text-ink-600">
                  {counts[i].total.toLocaleString("en-GB")} leads · {counts[i].doNotContact.toLocaleString("en-GB")} do-not-contact
                </p>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? <LeadListForm /> : null}
      </section>

      {selected ? (
        <>
          <section aria-labelledby="import-heading" className="space-y-3">
            <h2 id="import-heading" className="section-title">Import into &ldquo;{selected.name}&rdquo;</h2>
            {canEdit ? (
              <ImportForm leadListId={selected.id} defaultSourceType={selected.source_type} />
            ) : (
              <p className="card card-padded text-sm text-ink-600">Your role can view this list but not import into it.</p>
            )}
            {jobs.length > 0 ? (
              <div className="card overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <caption className="sr-only">Imports into this list</caption>
                  <thead>
                    <tr className="text-left text-ink-600">
                      <th scope="col" className="p-3 font-medium">When</th>
                      <th scope="col" className="p-3 font-medium">File</th>
                      <th scope="col" className="p-3 font-medium">Status</th>
                      <th scope="col" className="p-3 font-medium">Inserted</th>
                      <th scope="col" className="p-3 font-medium">Duplicates</th>
                      <th scope="col" className="p-3 font-medium">Invalid</th>
                      <th scope="col" className="p-3 font-medium">Suppressed</th>
                      <th scope="col" className="p-3 font-medium">Report</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.id} className="border-t border-ink-100">
                        <td className="p-3 whitespace-nowrap">{new Date(j.created_at).toLocaleString("en-GB")}</td>
                        <td className="p-3 break-all">{j.file_name ?? "pasted"}</td>
                        <td className="p-3">{j.status === "ready" ? "Done" : j.status === "running" ? "In progress" : "Failed"}</td>
                        <td className="p-3">{j.inserted_count}</td>
                        <td className="p-3">{j.duplicate_count}</td>
                        <td className="p-3">{j.invalid_count}</td>
                        <td className="p-3">{j.suppressed_count}</td>
                        <td className="p-3">
                          {j.error_report.length > 0 ? (
                            <a href={`/api/linkedin/imports/${j.id}/errors`} className="underline text-signal-800 inline-flex items-center min-h-11">
                              Download ({j.error_report.length})
                            </a>
                          ) : (
                            <span className="text-ink-500">none</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <section aria-labelledby="leads-table-heading" className="space-y-3">
            <h2 id="leads-table-heading" className="section-title">People in this list</h2>
            {page && page.rows.length > 0 ? (
              <div className="card overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <caption className="sr-only">Leads, newest first is not implied; ordered by when they were added</caption>
                  <thead>
                    <tr className="text-left text-ink-600">
                      <th scope="col" className="p-3 font-medium">Profile</th>
                      <th scope="col" className="p-3 font-medium">Name</th>
                      <th scope="col" className="p-3 font-medium">Company</th>
                      <th scope="col" className="p-3 font-medium">Title</th>
                      <th scope="col" className="p-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.rows.map((lead) => (
                      <tr key={lead.id} className="border-t border-ink-100 align-top">
                        <td className="p-3 break-all">{lead.canonical_profile_url}</td>
                        <td className="p-3 break-words">{lead.customer_provided_name ?? "—"}</td>
                        <td className="p-3 break-words">{lead.customer_provided_company ?? "—"}</td>
                        <td className="p-3 break-words">{lead.customer_provided_title ?? "—"}</td>
                        <td className="p-3">
                          {lead.do_not_contact ? (
                            <span className="badge badge-high">Do not contact</span>
                          ) : (
                            <span className="badge badge-neutral">Available</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="card card-padded text-sm text-ink-600">Nobody in this list yet.</p>
            )}
            {page?.nextCursor ? (
              <Link
                href={`/linkedin/leads?list=${selected.id}&after=${encodeURIComponent(`${page.nextCursor.createdAt}|${page.nextCursor.id}`)}`}
                className="btn-secondary min-h-11 w-full sm:w-auto"
              >
                Load more
              </Link>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
