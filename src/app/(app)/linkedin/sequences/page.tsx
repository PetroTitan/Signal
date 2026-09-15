import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { listSequences, listSequenceSteps } from "@/repositories/linkedin-sales-repository";
import { STEP_KIND_LABELS } from "@/core/linkedin-sales/state";
import { SequenceForm } from "./_sequence-form";

export const dynamic = "force-dynamic";

export default async function LinkedInSequencesPage() {
  if (!isSupabaseConfigured()) {
    return <p className="card card-padded text-sm text-ink-600">Connect Supabase to build sequences.</p>;
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) return <p className="card card-padded text-sm text-ink-600">No workspace found.</p>;
  const workspaceId = membership.workspace.id;
  const canEdit = can(membership.role, "edit_content");

  const sequences = await listSequences({ workspaceId });
  const steps = await Promise.all(sequences.map((s) => listSequenceSteps({ workspaceId, sequenceId: s.id })));

  return (
    <div className="space-y-6">
      <section aria-labelledby="sequences-heading" className="space-y-3">
        <h2 id="sequences-heading" className="section-title">Sequences</h2>
        <p className="text-sm text-ink-600 leading-relaxed">
          A sequence is the order of steps you will take with each person. Every step is a manual task; a wait is a pause between them.
        </p>
        {sequences.length === 0 ? (
          <p className="card card-padded text-sm text-ink-600">No sequences yet.</p>
        ) : (
          <ul className="list-none p-0 m-0 space-y-3">
            {sequences.map((s, i) => (
              <li key={s.id} className="card card-padded space-y-2">
                <p className="font-medium text-ink-900 break-words">{s.name}</p>
                <ol className="list-decimal pl-5 space-y-1 text-sm text-ink-800">
                  {steps[i].map((st) => (
                    <li key={st.id}>
                      {st.kind === "wait" ? `Wait ${st.wait_days} day${st.wait_days === 1 ? "" : "s"}` : STEP_KIND_LABELS[st.kind]}
                      {st.template ? <span className="block text-ink-600 break-words whitespace-pre-wrap">{st.template}</span> : null}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>
      {canEdit ? <SequenceForm /> : <p className="card card-padded text-sm text-ink-600">Your role can view sequences but not create them.</p>}
    </div>
  );
}
