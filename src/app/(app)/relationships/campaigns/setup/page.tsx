import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { listTargetProfiles } from "@/repositories/bluesky-relationship-repository";
import { countEligibleCandidates } from "@/repositories/bluesky-campaign-import-repository";
import { SetupWizard, type SetupTarget } from "./_setup-wizard";

export const dynamic = "force-dynamic";

/**
 * Setting up automatic following.
 *
 * Reached from the primary call to action on /relationships, which is
 * in the page header on every width — the previous route to this
 * capability was a nav entry that lived inside the More sheet on
 * mobile, so an operator working on a phone had no way to discover it.
 *
 * Counts here are exact and come from the database. A source may hold
 * 100,000 profiles; none of them are loaded to render this screen.
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar
        title="Start automatic following"
        description="Pick a list you have already imported, choose how many to follow each day, and Signal works through it for you."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl">{children}</div>
    </>
  );
}

export default async function CampaignSetupPage() {
  if (!isSupabaseConfigured()) {
    return (
      <Shell>
        <div className="card card-padded">
          <p className="text-sm text-ink-600">
            Connect Supabase to set up automatic following.
          </p>
        </div>
      </Shell>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <Shell>
        <div className="card card-padded">
          <p className="text-sm text-ink-600">No workspace found.</p>
        </div>
      </Shell>
    );
  }

  // The same permission that gates connecting an account and manual
  // Follow/Unfollow. Refused here as well as in the action, so a member
  // is told plainly rather than meeting an error after filling the form.
  if (!can(membership.role, "connect_platforms")) {
    return (
      <Shell>
        <div className="card card-padded">
          <h2 className="section-title">You cannot start this</h2>
          <p className="mt-1 text-sm text-ink-600">
            Automatic following can be set up by an owner or an admin. Ask one of
            them, or keep following people manually.
          </p>
          <Link href="/relationships" className="btn-secondary mt-4 inline-flex min-h-11 items-center">
            Back to relationships
          </Link>
        </div>
      </Shell>
    );
  }

  const identities = (
    await listAccountsByPlatform(membership.workspace.id, "bluesky")
  ).map((a: { id: string; handle: string | null; displayName: string | null }) => ({
    id: a.id,
    handle: a.handle,
    displayName: a.displayName,
  }));

  if (identities.length === 0) {
    return (
      <Shell>
        <div className="card card-padded">
          <h2 className="section-title">Connect a Bluesky account first</h2>
          <p className="mt-1 text-sm text-ink-600">
            Signal follows people from your own account, so it needs one to be
            connected before it can do anything.
          </p>
          <Link href="/accounts" className="btn-primary mt-4 inline-flex min-h-11 items-center">
            Go to Accounts
          </Link>
        </div>
      </Shell>
    );
  }

  const identityId = identities[0].id;

  const [targetRows, totals] = await Promise.all([
    listTargetProfiles(membership.workspace.id, identityId),
    countEligibleCandidates({
      workspaceId: membership.workspace.id,
      operatorAccountId: identityId,
      targetProfileId: null,
    }),
  ]);

  // Exact per-list counts, so the operator chooses knowing the size.
  const targets: SetupTarget[] = await Promise.all(
    targetRows.slice(0, 25).map(async (t) => {
      const counts = await countEligibleCandidates({
        workspaceId: membership.workspace.id,
        operatorAccountId: identityId,
        targetProfileId: t.id,
      });
      return {
        id: t.id,
        handle: t.handle,
        displayName: t.display_name,
        candidateCount: counts.eligible,
      };
    }),
  );

  if (totals.eligible === 0 && targets.every((t) => t.candidateCount === 0)) {
    return (
      <Shell>
        <div className="card card-padded" data-testid="setup-empty">
          <h2 className="section-title">Import some profiles first</h2>
          <p className="mt-1 text-sm text-ink-600 leading-relaxed">
            Automatic following works through a list you have already collected.
            Import a profile&apos;s followers on the Relationships page, then come
            back.
          </p>
          <Link href="/relationships" className="btn-primary mt-4 inline-flex min-h-11 items-center">
            Import profiles
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <SetupWizard
        identities={identities}
        targets={targets.filter((t) => t.candidateCount > 0)}
        // A sensible default the operator can change. Resolved on the
        // server so the first paint is not a flash of UTC.
        defaultTimezone={
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        }
        candidateTotal={totals.eligible}
      />
      <p className="mt-6 text-sm text-ink-500 leading-relaxed">
        Nothing is followed until you confirm on the last step. Leaving this page
        before then sends nothing to Bluesky.
      </p>
    </Shell>
  );
}
