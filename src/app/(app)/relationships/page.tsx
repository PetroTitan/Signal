import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadRelationships } from "@/core/bluesky-relationships/load-relationships.server";
import { RELATIONSHIP_MAX_DURATION_SECONDS } from "@/core/bluesky-relationships/limits";
import { RelationshipUi } from "./_relationship-ui";

export const dynamic = "force-dynamic";

/**
 * Relationship batches run synchronously inside the operator's request
 * — there is no queue and no background worker, by design. The default
 * serverless budget is far below the worst case for a full batch, so it
 * is declared explicitly and kept in step with the batch cap by
 * `RELATIONSHIP_MAX_DURATION_SECONDS`. See `limits.ts` for the
 * arithmetic tying the two together.
 */
export const maxDuration = RELATIONSHIP_MAX_DURATION_SECONDS;

/**
 * Bluesky Relationships.
 *
 * Import a profile's followers, work through one deduplicated
 * candidate list, and follow or unfollow accounts the operator has
 * explicitly selected.
 *
 * There is no scoring on this page, no recommendation, no growth
 * projection and no automation. Every mutation starts with a person
 * pressing a button.
 */

export default async function RelationshipsPage({
  searchParams,
}: {
  /**
   * The whole surface is a pure function of the URL: which identity,
   * which tab, the search term, the state filter and both page numbers.
   * That makes a filtered view shareable and the Back button correct,
   * and it keeps filtering and counting on the server where the row
   * count actually lives.
   */
  searchParams?: {
    identity?: string;
    tab?: string;
    q?: string;
    state?: string;
    page?: string;
    hpage?: string;
  };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Bluesky relationships"
          description="Import followers, then follow or unfollow accounts you select."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">
              Connect Supabase to manage Bluesky relationships.
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
        <Topbar
          title="Bluesky relationships"
          description="Import followers, then follow or unfollow accounts you select."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">
          <div className="card card-padded">
            <p className="text-sm text-ink-600">No workspace found.</p>
          </div>
        </div>
      </>
    );
  }

  const view = await loadRelationships({
    workspaceId: membership.workspace.id,
    operatorAccountId: searchParams?.identity ?? null,
    searchParams,
  });

  return (
    <>
      <Topbar
        title="Bluesky relationships"
        description="Import a profile's followers, then follow or unfollow the accounts you pick. Nothing here runs on its own."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl">
        <RelationshipUi
          identities={view.identities}
          selectedIdentityId={view.selectedIdentityId}
          connected={view.connected}
          query={view.query}
          targets={view.targets}
          candidates={view.candidates}
          candidatePage={view.candidatePage}
          history={view.history}
          historyPage={view.historyPage}
          batches={view.batches}
          counts={view.counts}
          // A Map cannot cross the server/client boundary; the object is
          // the same data in a serialisable shape.
          targetLabels={Object.fromEntries(view.targetLabels)}
        />
      </div>
    </>
  );
}
