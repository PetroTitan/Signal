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
import { IdentitySourcesEditor } from "./_identity-sources-editor";
import { PublishingCapabilitiesPanel } from "./_capabilities-panel";
import { GenerateDraftButton } from "./_generate-draft-button";
import { IdentityCardWithManage } from "./_identity-card-with-manage";
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
import {
  resolveConnectIdentityPlan,
  type ConnectIdentityPlan,
} from "@/core/publishing/connect-identity";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import type { IdentityAuthCounts } from "./_capabilities-panel";
import { readGenerationProviderStatus } from "@/core/generation/provider-status";

export const dynamic = "force-dynamic";

function isOAuthPlatform(p: string): p is OAuthPlatform {
  return p === "reddit" || p === "x" || p === "linkedin";
}

/**
 * Pulls the structured handle-mismatch payload off a connection's
 * metadata blob. The OAuth callback writes `metadata.handle_mismatch
 * = { declared, authenticated, observedAt }` when the authenticated
 * handle disagrees with the identity's declared handle. Untyped
 * because the connection metadata column is JSONB; we narrow at the
 * read site.
 */
function extractMismatchEvidence(
  metadata: unknown,
): { declared: string | null; authenticated: string | null } | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).handle_mismatch;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  return {
    declared: typeof m.declared === "string" ? m.declared : null,
    authenticated:
      typeof m.authenticated === "string" ? m.authenticated : null,
  };
}

/**
 * Hashnode-specific: read the publication id off the connection
 * metadata. Returns the trimmed string when present and non-empty;
 * otherwise null. Used both to feed the `requirementsMet` gate of
 * the publish-state resolver and to pre-fill the inline
 * publication-id form in the Manage panel.
 */
function extractHashnodePublicationId(
  metadata: unknown,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).publication_id;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Telegram-specific: read the target type off the connection
 * metadata. Defaults to "channel" for legacy rows that predate the
 * group/supergroup support (the pre-PR verifier only verified
 * channels). Matches the contract documented on
 * `readTelegramTargetType` in the verifiers index.
 */
function extractTelegramTargetType(
  metadata: unknown,
): "channel" | "group" | "supergroup" {
  if (!metadata || typeof metadata !== "object") return "channel";
  const raw = (metadata as Record<string, unknown>).telegram_target_type;
  if (raw === "channel" || raw === "group" || raw === "supergroup") {
    return raw;
  }
  return "channel";
}

/**
 * Telegram-specific: read the persisted target label (chat.title
 * or @username) off the connection metadata. Returns null when not
 * set so the UI falls back to identity.handle.
 */
function extractTelegramTargetLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).telegram_target_label;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Per-platform completeness gate. The resolver does not embed
 * platform-specific config rules; this helper does. Today only
 * Hashnode has a "credential alone is not enough" requirement
 * (publication id). All other platforms return undefined so the
 * resolver treats them as "no extra requirement applies."
 *
 * Returning undefined (not true) for non-Hashnode platforms makes
 * resolver call sites match exactly what the resolver expects —
 * undefined means "no platform-specific requirement," which collapses
 * to `connected` once auth is healthy.
 */
function computeRequirementsMet(
  platform: FounderPlatform,
  metadata: unknown,
): boolean | undefined {
  if (platform === "hashnode") {
    return extractHashnodePublicationId(metadata) !== null;
  }
  return undefined;
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
    // Reddit is OAuth, not tier-1 in the env-var sense — but it has
    // the same shape from the resolver's perspective: a workspace-
    // level integration that must be configured before any identity
    // can sign in. We thread `configured` as the AND of provider env
    // (REDDIT_CLIENT_ID), encryption (TOKEN_ENCRYPTION_KEY), and
    // the !blocked flag so the resolver returns `pending_auth`
    // (rather than a misleading state) when the OAuth flow is
    // unusable. The /accounts page also surfaces the existing
    // Reddit-specific helperNote separately in the blocked case.
    reddit:
      providerConfigured.reddit && !redditOauthBlocked && encryptionOn,
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

    // Platform-specific completeness gate. The resolver does NOT
    // enumerate what each platform requires — we compute the boolean
    // here at the call site, which already knows the platform.
    //
    // Today: Hashnode is the only platform with a "credential alone
    // is not enough" requirement (the publication_id must be set on
    // connection.metadata.publication_id). Other platforms default to
    // undefined → resolver treats as "no requirement applies" and
    // returns `connected` once auth is healthy.
    const requirementsMet = computeRequirementsMet(
      platformKey,
      connection?.metadata,
    );

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
            // Persist the mismatch verdict across the redirect cycle:
            // the callback writes connection_status='error' (so
            // publishing-policy keeps refusing) and stores the
            // mismatch payload on metadata. The resolver reads this
            // flag to short-circuit to `mismatched`.
            handleMismatchObserved:
              extractMismatchEvidence(connection.metadata) !== null,
          }
        : null,
      requirementsMet,
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

  // Resolve the Connect plan per identity (oauth / api_key_verify /
  // manual / unsupported). Drives the per-identity Connect button.
  const connectPlanByIdentity = new Map<string, ConnectIdentityPlan>();
  for (const account of accounts) {
    const platformKey = account.platform as FounderPlatform;
    const guidance = resolveIdentityPlatformGuidance(platformKey);
    const plan = resolveConnectIdentityPlan({
      identityId: account.id,
      platform: platformKey,
      publishingMode: guidance?.publishingMode ?? "not_implemented",
      distributionOnly: guidance?.distributionOnly ?? false,
      // Reddit is the only OAuth-capable platform that is also
      // currently runnable: providerConfigured says env-var clientId
      // is set, and redditOauthBlocked says the API approval isn't
      // live. Both must be true for the oauth plan to be useful.
      oauthAvailable:
        platformKey === "reddit"
          ? providerConfigured.reddit && !redditOauthBlocked && encryptionOn
          : false,
      redirectAfter: "/accounts",
    });
    connectPlanByIdentity.set(account.id, plan);
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
              // Look up the per-identity connection row regardless of
              // platform — once api_key_verify platforms ship their
              // verifiers, those rows will live in platform_
              // connections too. (Today only OAuth platforms have
              // rows; the lookup just returns undefined for others.)
              const c = connectionByAccountPlatform.get(
                `${a.id}|${a.platform}`,
              );
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
              const plan = connectPlanByIdentity.get(a.id);
              const identityPublishState = identityPublishStateById.get(a.id);
              const mismatchEvidence =
                identityPublishState === "mismatched"
                  ? extractMismatchEvidence(c?.metadata)
                  : null;

              // Auth controls visible only when Manage panel is open.
              // Every plan kind with real sign-in actions dispatches
              // via ConnectionControls. Manual platforms get a
              // steady-state hint instead (rendered both when Manage
              // is open and when collapsed). Keep this list in sync
              // with the render branches inside ConnectionControls —
              // dropping a kind here leaves operators with an empty
              // Manage panel.
              const authControls =
                plan &&
                (plan.kind === "oauth" ||
                  plan.kind === "api_key_verify" ||
                  plan.kind === "app_password" ||
                  plan.kind === "personal_api_key") ? (
                  <ConnectionControls
                    platform={a.platform}
                    accountId={a.id}
                    providerConfigured={
                      isOAuthPlatform(a.platform)
                        ? providerConfigured[a.platform]
                        : true
                    }
                    encryptionConfigured={encryptionOn}
                    redditOauthBlocked={redditOauthBlocked}
                    connectionStatus={c?.connectionStatus ?? "not_connected"}
                    healthStatus={c?.healthStatus ?? "unknown"}
                    hasAccessToken={c?.hasAccessToken ?? false}
                    lastCheckedAt={c?.lastCheckedAt ?? null}
                    handle={c?.handle ?? a.handle}
                    publishState={identityPublishState}
                    connectPlan={plan}
                    mismatchEvidence={mismatchEvidence}
                    // Hashnode-only: pre-fill the inline publication-id
                    // form in the Manage panel. Other platforms ignore
                    // this prop. Sourced from the same metadata
                    // location the orchestrator reads at publish time
                    // (connection.metadata.publication_id) so the UI
                    // and the publish path agree on what's stored.
                    hashnodePublicationId={
                      a.platform === "hashnode"
                        ? extractHashnodePublicationId(c?.metadata)
                        : null
                    }
                    // Telegram-only: pre-fill the target-type selector
                    // and surface the persisted label + chat id in
                    // the Manage panel. Legacy rows without
                    // `metadata.telegram_target_type` default to
                    // "channel" (matches the pre-PR behavior).
                    telegramTargetType={
                      a.platform === "telegram"
                        ? extractTelegramTargetType(c?.metadata)
                        : null
                    }
                    telegramTargetLabel={
                      a.platform === "telegram"
                        ? extractTelegramTargetLabel(c?.metadata)
                        : null
                    }
                    telegramChatId={
                      a.platform === "telegram"
                        ? (c?.providerAccountId ?? null)
                        : null
                    }
                  />
                ) : null;

              const manualHint =
                plan?.kind === "manual" ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-ink-700">{plan.hint}</p>
                    {plan.note ? (
                      <p className="text-[10px] text-ink-500 italic leading-relaxed">
                        {plan.note}
                      </p>
                    ) : null}
                  </div>
                ) : null;

              const controlsWhenOpen = (
                <div className="flex flex-col gap-3">
                  {authControls ?? manualHint}
                  <div className="flex items-center gap-2 flex-wrap">
                    {generateButton}
                  </div>
                </div>
              );
              const guidance = resolveIdentityPlatformGuidance(a.platform);
              const voiceProfileSlot = (
                <div className="space-y-3">
                  <VoiceProfileEditor
                    accountId={a.id}
                    initialValue={a.voiceProfile ?? a.role ?? null}
                    platformHint={guidance?.voiceHint ?? null}
                  />
                  <IdentitySourcesEditor
                    accountId={a.id}
                    initialSourceWebsiteUrl={a.sourceWebsiteUrl}
                    initialReferenceUrls={a.referenceUrls}
                  />
                </div>
              );
              return (
                <IdentityCardWithManage
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
                  connectPlan={plan}
                  controlsWhenOpen={controlsWhenOpen}
                  steadyStateHint={manualHint}
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

