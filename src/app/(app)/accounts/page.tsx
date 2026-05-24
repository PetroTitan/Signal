import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listProducts } from "@/repositories/product-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
  isRedditOauthBlocked,
} from "@/lib/oauth/env";
import { type OAuthPlatform } from "@/core/platform-oauth";
import { AccountCreateForm } from "./_create-form";
import { ArchiveAccountButton } from "./_archive-button";
import { ConnectionControls } from "./_connection-controls";
import { VoiceProfileEditor } from "./_voice-profile-editor";
import { PublishingCapabilitiesPanel } from "./_capabilities-panel";
import { GenerateDraftButton } from "./_generate-draft-button";
import { AccountIdentityCard } from "@/components/publishing/account-identity-card";
import {
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";
import {
  narrowConnectionAuthStatus,
  resolveIdentityPublishState,
  toPlatformCapability,
  type IdentityPublishState,
} from "@/core/publishing/identity-publish-state";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import type { IdentityAuthCounts } from "./_capabilities-panel";
import { readGenerationProviderStatus } from "@/core/generation/provider-status";

export const dynamic = "force-dynamic";

function isOAuthPlatform(p: string): p is OAuthPlatform {
  return p === "reddit" || p === "x" || p === "linkedin";
}

/**
 * F5.0 — only Reddit currently has a functional OAuth flow worth
 * surfacing in the founder UI. X and LinkedIn are accepted as
 * OAuth platforms by the legacy schema but Signal uses them in
 * manual-distribution mode only — Connect / Disconnect controls
 * don't apply.
 */
function hasInProductConnectionFlow(p: string): boolean {
  return p === "reddit";
}

export default async function AccountsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Publishing identities"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="rounded-2xl border border-ink-200 bg-white p-5 text-sm text-ink-600">
            Supabase is not configured. Set the Supabase env variables to
            enable identity persistence.
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
          title="Publishing identities"
          description="No workspace found."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard to start adding publishing
          identities.
        </div>
      </>
    );
  }

  const [accounts, products, connections, recentPublishes] =
    await Promise.all([
      listAccounts(membership.workspace.id),
      listProducts(membership.workspace.id),
      listPlatformConnections(membership.workspace.id),
      listRecentPublishes(membership.workspace.id, 100),
    ]);

  const providerConfigured: Record<OAuthPlatform, boolean> = {
    reddit: isOAuthProviderConfigured("reddit"),
    x: isOAuthProviderConfigured("x"),
    linkedin: isOAuthProviderConfigured("linkedin"),
  };
  const encryptionOn = hasTokenEncryptionKey();
  const redditOauthBlocked = isRedditOauthBlocked();

  const connectionByAccountPlatform = new Map<
    string,
    (typeof connections)[number]
  >();
  for (const c of connections) {
    if (c.accountId) {
      connectionByAccountPlatform.set(`${c.accountId}|${c.platform}`, c);
    }
  }

  const providerStatus = readGenerationProviderStatus();

  // Last successful publish per account.
  const lastPublishByAccount = new Map<string, string>();
  for (const p of recentPublishes) {
    if (p.outcome !== "published" || !p.accountId) continue;
    const prev = lastPublishByAccount.get(p.accountId);
    if (!prev || new Date(p.finishedAt) > new Date(prev)) {
      lastPublishByAccount.set(p.accountId, p.finishedAt);
    }
  }

  // Phase 5 — per-identity publish-state resolution. The resolver is
  // the single source of truth for "can Signal publish for this
  // identity right now?" — it composes platform capability + workspace
  // integration + identity auth + handle match into one deterministic
  // verdict.
  const tier1 = readTierOneConfigStatus();
  const tier1Configured: Partial<Record<FounderPlatform, boolean>> = {
    devto: tier1.devto.configured,
    hashnode: tier1.hashnode.configured,
    bluesky: tier1.bluesky.configured,
    telegram: tier1.telegram.configured,
  };

  const identityPublishStateById = new Map<string, IdentityPublishState>();
  const identityAuthCounts: Partial<Record<FounderPlatform, IdentityAuthCounts>> = {};

  for (const account of accounts) {
    const platformKey = account.platform as FounderPlatform;
    const guidance = resolveIdentityPlatformGuidance(platformKey);
    const platformCapability = guidance
      ? toPlatformCapability(guidance)
      : { publishingMode: "not_implemented" as const };

    const connection = connectionByAccountPlatform.get(
      `${account.id}|${account.platform}`,
    );

    const workspaceConfigured = tier1Configured[platformKey];
    const workspace =
      workspaceConfigured === undefined
        ? null
        : { configured: workspaceConfigured };

    const publishState = resolveIdentityPublishState({
      identity: {
        platform: platformKey,
        workspaceId: account.workspaceId,
        declaredHandle: account.handle,
        disabled: account.status === "paused",
        lifecycleStatus: account.status as
          | "planned"
          | "warming"
          | "active"
          | "paused"
          | "setup_needed"
          | "awaiting_manual_creation"
          | "archived",
      },
      platform: platformCapability,
      workspace,
      connection: connection
        ? {
            authStatus: narrowConnectionAuthStatus(connection.connectionStatus),
            platform: connection.platform as FounderPlatform,
            workspaceId: connection.workspaceId,
            authenticatedHandle: connection.handle,
            providerAccountId: null,
            expiresAt: connection.expiresAt,
          }
        : null,
    });
    identityPublishStateById.set(account.id, publishState);

    const existing = identityAuthCounts[platformKey] ?? {
      authenticated: 0,
      total: 0,
    };
    existing.total += 1;
    if (publishState === "connected") existing.authenticated += 1;
    identityAuthCounts[platformKey] = existing;
  }

  return (
    <>
      <Topbar
        title="Publishing identities"
        description="The voices Signal writes and publishes in. Each identity has its own platform, writing profile, and connection."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        <PublishingCapabilitiesPanel identityAuthCounts={identityAuthCounts} />

        {accounts.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-ink-300 bg-ink-50/40 p-8 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No publishing identities yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Add the first voice Signal will write in — pick a platform,
              give it a name, and describe how it sounds.
            </p>
          </section>
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => {
              const c = isOAuthPlatform(a.platform)
                ? connectionByAccountPlatform.get(`${a.id}|${a.platform}`)
                : undefined;
              const helperNote =
                a.platform === "reddit" && redditOauthBlocked
                  ? "Reddit is in manual publish mode while their API approval is pending. Drafts still flow through the weekly plan."
                  : null;
              const archive = <ArchiveAccountButton accountId={a.id} />;
              const guidanceForCard = resolveIdentityPlatformGuidance(
                a.platform,
              );
              const generateButton = (
                <GenerateDraftButton
                  identity={{
                    id: a.id,
                    platform: a.platform,
                    platformLabel:
                      guidanceForCard?.label ?? a.platform,
                    displayName: a.displayName,
                    productId: a.productId,
                  }}
                  providerAvailable={providerStatus.available}
                />
              );
              const oauthControls =
                isOAuthPlatform(a.platform) &&
                hasInProductConnectionFlow(a.platform) ? (
                  <ConnectionControls
                    platform={a.platform}
                    accountId={a.id}
                    providerConfigured={providerConfigured[a.platform]}
                    encryptionConfigured={encryptionOn}
                    redditOauthBlocked={redditOauthBlocked}
                    connectionStatus={c?.connectionStatus ?? "not_connected"}
                    healthStatus={c?.healthStatus ?? "unknown"}
                    hasAccessToken={c?.hasAccessToken ?? false}
                    lastCheckedAt={c?.lastCheckedAt ?? null}
                  />
                ) : a.platform === "x" ||
                  a.platform === "linkedin" ||
                  a.platform === "youtube" ||
                  a.platform === "threads" ||
                  a.platform === "instagram" ? (
                  <p className="text-[11px] text-ink-500 italic">
                    Manual distribution — Signal opens the native composer
                    and you publish on the platform itself.
                  </p>
                ) : a.platform === "telegram" ? (
                  <p className="text-[11px] text-ink-500 italic">
                    Telegram channel. Add the channel @username as the
                    handle, and add this workspace&apos;s bot to your
                    channel as an admin.
                  </p>
                ) : null;
              const controls = (
                <div className="flex flex-col gap-3">
                  {oauthControls}
                  <div className="flex items-center gap-2 flex-wrap">
                    {generateButton}
                  </div>
                </div>
              );
              const guidance = resolveIdentityPlatformGuidance(a.platform);
              const voiceProfileSlot = (
                <VoiceProfileEditor
                  accountId={a.id}
                  initialValue={a.voiceProfile ?? a.role ?? null}
                  platformHint={guidance?.voiceHint ?? null}
                />
              );
              return (
                <AccountIdentityCard
                  key={a.id}
                  platform={a.platform}
                  displayName={a.displayName}
                  handle={c?.handle ?? a.handle}
                  connectionState={c?.connectionStatus ?? "not_connected"}
                  publishState={identityPublishStateById.get(a.id)}
                  lastPublishedAt={lastPublishByAccount.get(a.id) ?? null}
                  lastCheckedAt={c?.lastCheckedAt ?? null}
                  notes={null}
                  helperNote={helperNote}
                  voiceProfile={voiceProfileSlot}
                  controls={controls}
                  archiveControl={archive}
                />
              );
            })}
          </div>
        )}

        <AccountCreateForm
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Some platforms publish automatically once connected; others stay
          manual-first. Signal never asks for passwords, cookies, session
          tokens, 2FA codes, or recovery codes.
        </p>
      </div>
    </>
  );
}

