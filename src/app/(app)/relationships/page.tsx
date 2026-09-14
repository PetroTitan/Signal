import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { loadRelationships } from "@/core/bluesky-relationships/load-relationships.server";
import { ReadFailureNotice } from "./_read-failure-notice";
import { RelationshipUi } from "./_relationship-ui";
import {
  AutomationPanel,
  StartAutomationCta,
  StartUnfollowCta,
} from "./_automation-panel";
import { loadCampaignSummary } from "@/core/bluesky-campaigns/load-campaign-summary.server";
import { can } from "@/core/teams/permissions";

export const dynamic = "force-dynamic";

/**
 * Relationship batches and follower imports run synchronously inside
 * the operator's request. A manual Follow/Unfollow batch remains
 * structurally capped at 20; the longer budget lets one resumable,
 * read-only follower import fetch up to 10,000 profiles in one click.
 *
 * This MUST be a literal. Next.js reads segment config statically, and
 * an imported constant here is not resolved: the build warns "Unknown
 * identifier … The default config will be used instead", which is a
 * silent revert to the default that no test would otherwise notice.
 * `RELATIONSHIP_MAX_DURATION_SECONDS` in `limits.ts` carries the
 * arithmetic that chose this number, and a test parses this literal and
 * fails if the two drift apart.
 */
export const maxDuration = 300;

/**
 * Bluesky Relationships.
 *
 * Import a profile's followers into one deduplicated list. Automatic
 * campaigns work through that list over time; manual Follow/Unfollow
 * remains available for explicitly selected exceptions.
 *
 * There is no scoring on this page, no recommendation, no growth
 * projection and no hidden selection logic. Campaign activation and
 * every immediate manual mutation still require an operator decision.
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

  const [view, automation] = await Promise.all([
    loadRelationships({
      workspaceId: membership.workspace.id,
      operatorAccountId: searchParams?.identity ?? null,
      searchParams,
    }),
    // A summary, not the campaign. The queue behind it may hold 100,000
    // members and none of them are read to draw the panel.
    loadCampaignSummary({ workspaceId: membership.workspace.id }),
  ]);

  // Starting automatic following is a write, so the button is not shown
  // to a member who could not complete it.
  const canManage = can(membership.role, "connect_platforms");

  return (
    <>
      <Topbar
        title="Bluesky relationships"
        description="Follow or unfollow accounts one at a time, or let Signal work through a whole list for you."
        actions={
          // In the header, so both are on screen on a 320px phone
          // without opening any secondary navigation. They wrap rather
          // than overflow: two 44px targets do not fit side by side at
          // 320px, and a control pushed off the edge is a control that
          // does not exist.
          <div className="flex flex-wrap gap-2">
            <StartAutomationCta canManage={canManage} compact />
            <StartUnfollowCta canManage={canManage} compact />
          </div>
        }
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-6">
        {automation ? (
          <AutomationPanel summary={automation} />
        ) : canManage ? (
          <section className="card card-padded" data-testid="automation-empty">
            <h2 className="section-title">Let Signal do the following</h2>
            <p className="mt-1 text-sm text-ink-600 leading-relaxed">
              Pick a list you have already imported and a number of profiles per
              day. Signal follows that many each day, on the schedule you set,
              until the whole list is done — you do not need to keep this page
              open.
            </p>
            <p className="mt-2 text-sm text-ink-500 leading-relaxed">
              The buttons below stay manual: they follow only the profiles you
              select, right away.
            </p>
            <div className="mt-4">
              <StartAutomationCta canManage={canManage} />
            </div>
          </section>
        ) : null}
        {view.failure ? (
          // Rendered INSTEAD of the lists. An empty list beside a
          // failed read reads as "nothing here yet", which is the one
          // thing this page must never imply after a failure.
          <ReadFailureNotice failure={view.failure} />
        ) : (
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
          automation={{
            hasCampaign: automation !== null,
            canManage,
            href: automation
              ? `/relationships/campaigns?campaign=${encodeURIComponent(automation.id)}`
              : "/relationships/campaigns/setup",
          }}
          // A Map cannot cross the server/client boundary; the object is
          // the same data in a serialisable shape.
          targetLabels={Object.fromEntries(view.targetLabels)}
        />
        )}
      </div>
    </>
  );
}
