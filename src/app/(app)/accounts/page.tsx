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
import { AccountIdentityCard } from "@/components/publishing/account-identity-card";
import { resolveIdentityPlatformGuidance } from "@/core/publishing/platform-guidance";

export const dynamic = "force-dynamic";

function isOAuthPlatform(p: string): p is OAuthPlatform {
  return p === "reddit" || p === "x" || p === "linkedin";
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

  // Last successful publish per account.
  const lastPublishByAccount = new Map<string, string>();
  for (const p of recentPublishes) {
    if (p.outcome !== "published" || !p.accountId) continue;
    const prev = lastPublishByAccount.get(p.accountId);
    if (!prev || new Date(p.finishedAt) > new Date(prev)) {
      lastPublishByAccount.set(p.accountId, p.finishedAt);
    }
  }

  return (
    <>
      <Topbar
        title="Publishing identities"
        description="The voices Signal writes and publishes in. Each identity has its own platform, writing profile, and connection."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        <PublishingCapabilitiesPanel />

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
              const controls = isOAuthPlatform(a.platform) ? (
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
              ) : (
                <p className="text-[11px] text-ink-400 italic">
                  This platform uses an API key or app-password instead of
                  an in-app connection.
                </p>
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

