import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { can } from "@/core/teams/permissions";
import { listAccountsByPlatform } from "@/repositories/account-repository";
import { listTargetProfiles } from "@/repositories/bluesky-relationship-repository";
import { listCampaigns, countMembersByStatus } from "@/repositories/bluesky-campaign-repository";
import { listAllowlist } from "@/repositories/bluesky-unfollow-repository";
import { UnfollowWizard } from "./_unfollow-wizard";
import { AllowlistPanel } from "./_allowlist-panel";
import {
  CAMPAIGN_SERVICE_DB_CONFIG_ERROR,
  requireCampaignServiceDb,
} from "@/core/bluesky-campaigns/service-db.server";

export const dynamic = "force-dynamic";

/**
 * Setting up automatic unfollowing.
 *
 * Reached from the primary action in Bluesky Relationships, on every
 * width — a capability behind a nav entry inside a mobile More sheet is
 * a capability an operator on a phone cannot find.
 *
 * Counts here are exact and come from the database. A source may hold
 * 100,000 profiles; none of them are loaded to render this screen.
 */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Topbar
        title="Unfollow people"
        description="Choose who to stop following, how many a day, and confirm once. Signal works through the list on its own."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl">{children}</div>
    </>
  );
}

export default async function UnfollowSetupPage() {
  if (!isSupabaseConfigured()) {
    return (
      <Shell>
        <div className="card card-padded">
          <p className="text-sm text-ink-600 leading-relaxed">
            Connect Supabase to set up automatic unfollowing.
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
          <p className="text-sm text-ink-600 leading-relaxed">
            No workspace found.
          </p>
        </div>
      </Shell>
    );
  }

  const canManage = can(membership.role, "connect_platforms");

  // Fail EARLY and visibly if this deployment cannot run campaigns at
  // all. Letting an operator configure one and discover at activation
  // that the worker is unconfigured wastes their time on a screen whose
  // whole purpose is a considered decision.
  let serviceDbError: string | null = null;
  try {
    requireCampaignServiceDb();
  } catch {
    serviceDbError = CAMPAIGN_SERVICE_DB_CONFIG_ERROR;
  }

  const accounts = await listAccountsByPlatform(membership.workspace.id, "bluesky");
  const accountsFirst = accounts[0];

  const [targets, campaigns, allowlist] = await Promise.all([
    listTargetProfiles(membership.workspace.id, accountsFirst?.id ?? "").catch(
      () => [],
    ),
    listCampaigns(membership.workspace.id).catch(() => []),
    listAllowlist({ workspaceId: membership.workspace.id }).catch(() => []),
  ]);

  const followCampaigns = await Promise.all(
    campaigns
      .filter((c) => c.kind === "follow")
      .slice(0, 25)
      .map(async (c) => {
        const counts = await countMembersByStatus({
          workspaceId: membership.workspace.id,
          campaignId: c.id,
        }).catch(() => null);
        return {
          id: c.id,
          name: c.name,
          succeeded: counts?.succeeded ?? 0,
        };
      }),
  );

  const existing = campaigns.filter((c) => c.kind === "unfollow");

  return (
    <Shell>
      <div className="space-y-4">
        <p className="text-sm text-ink-700 leading-relaxed">
          <Link href="/relationships" className="underline">
            Back to Relationships
          </Link>
        </p>

        {serviceDbError ? (
          <div className="card card-padded">
            <p className="text-sm text-red-700 leading-relaxed" role="alert">
              {serviceDbError}
            </p>
          </div>
        ) : null}

        {existing.length > 0 ? (
          <section className="card card-padded space-y-2">
            <h2 className="section-title">Your unfollow campaigns</h2>
            <ul className="list-none p-0 m-0 space-y-2">
              {existing.map((c) => (
                <li key={c.id} className="flex flex-wrap gap-2 items-baseline">
                  <Link
                    href={`/relationships/unfollow/${c.id}`}
                    className="text-sm font-medium text-ink-900 underline break-words"
                  >
                    {c.name}
                  </Link>
                  <span className="badge-info">{c.status.replace(/_/g, " ")}</span>
                  {c.dry_run ? <span className="badge-info">dry run</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <UnfollowWizard
          identities={accounts.map((a) => ({
            id: a.id,
            handle: a.handle,
            displayName: a.displayName,
          }))}
          targets={targets.map((t) => ({
            id: t.id,
            handle: t.handle,
            displayName: t.display_name,
            // The setup screen shows targets, not their sizes: the
            // unfollow source is "whoever from that list you currently
            // follow", which is a different number and is counted
            // exactly by `count_bluesky_unfollow_source` in step 1.
            candidateCount: 0,
          }))}
          followCampaigns={followCampaigns.filter((c) => c.succeeded > 0)}
          defaultTimezone="UTC"
          canManage={canManage}
        />

        <AllowlistPanel
          entries={allowlist}
          identities={accounts.map((a) => ({ id: a.id, handle: a.handle }))}
          canManage={canManage}
        />
      </div>
    </Shell>
  );
}
