import { Topbar } from "@/components/topbar";
import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { HashnodePublicationForm } from "./_hashnode-publication-form";

export const dynamic = "force-dynamic";

/**
 * /settings/setup — operator-facing setup hub.
 *
 * Built for non-founder operators who need to connect publishing
 * automation without asking the founder. The page is intentionally
 * long so a single visit covers the full setup story: overview,
 * required steps, per-platform sections, safety rules,
 * troubleshooting, and a visual status table.
 *
 * The page is truthful about which platforms are automated end-to-end
 * vs. manual / planned. We do not claim X / LinkedIn / YouTube /
 * Threads / Instagram are automated — those are routed through
 * manual confirmation today.
 *
 * Loading: identities + connections are loaded server-side so the
 * Hashnode publication-id form is pre-populated with whatever is
 * already stored in `platform_connections.metadata.publication_id`.
 *
 * No secret display: this page never shows API keys, tokens, cookies,
 * or encrypted blobs. It only shows operator-visible identifiers
 * (publication ids, usernames, chat ids).
 */
export default async function SetupPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Setup"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="rounded-2xl border border-ink-200 bg-white p-5 text-sm text-ink-600">
            Supabase is not configured. Set the Supabase environment
            variables before connecting publishing automation.
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
          title="Setup"
          description="No workspace found."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard first.
        </div>
      </>
    );
  }

  const [accounts, connections] = await Promise.all([
    listAccounts(membership.workspace.id),
    listPlatformConnections(membership.workspace.id),
  ]);

  const hashnodeIdentities = accounts.filter((a) => a.platform === "hashnode");
  const connectionByAccountPlatform = new Map<string, (typeof connections)[number]>();
  for (const c of connections) {
    if (c.accountId) {
      connectionByAccountPlatform.set(`${c.accountId}|${c.platform}`, c);
    }
  }

  return (
    <>
      <Topbar
        title="Setup"
        description="Connect publishing automation for this workspace."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {/* ───────────── Overview ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Overview</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Signal publishes on your behalf only after you connect the
            right credentials and approve each post. This page lists
            every step a non-founder operator needs to take to bring
            publishing automation online. The founder does not have to
            be in the loop — every action below is exposed in the UI
            with proper auth.
          </p>
          <p className="text-xs text-ink-600 mt-2 leading-relaxed">
            Signal stores credentials encrypted (AES-256-GCM, per-
            identity). The plaintext value is never echoed back to the
            UI after you save it, never logged, and never sent to any
            third party. The scheduler decrypts it only at the moment
            of a publish call.
          </p>
        </section>

        {/* ───────────── Required setup checklist ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Required setup checklist
          </h2>
          <ol className="mt-3 space-y-2 text-sm text-ink-800 list-decimal pl-5">
            <li>
              <span className="font-medium">Add identities.</span> Open{" "}
              <Link href="/accounts" className="text-signal-700 underline">
                Accounts
              </Link>{" "}
              and create one identity per platform you want to publish
              to. The identity&apos;s handle must match the account
              you intend to publish from.
            </li>
            <li>
              <span className="font-medium">
                Connect each identity&apos;s credentials.
              </span>{" "}
              On the identity card, use the per-platform connect
              control: OAuth (Reddit) or API key / app password
              (Bluesky, dev.to, Hashnode). The verifier proves
              ownership before storing anything.
            </li>
            <li>
              <span className="font-medium">
                Set Hashnode publication ids
              </span>{" "}
              (Hashnode only) below — Hashnode needs a publication id
              alongside the API key, and the verifier can&apos;t
              auto-discover it.
            </li>
            <li>
              <span className="font-medium">
                Configure the Telegram bot
              </span>{" "}
              (Telegram only) — set TELEGRAM_BOT_TOKEN in the
              workspace environment and add the bot as an admin of
              each target channel. The per-channel chat id lives on
              the identity&apos;s handle field.
            </li>
            <li>
              <span className="font-medium">
                Confirm at least one weekly contract is active
              </span>{" "}
              (
              <Link
                href="/weekly-contracts"
                className="text-signal-700 underline"
              >
                Publishing scope
              </Link>
              ). The scheduler refuses to publish without an active
              contract whose scope includes the account, product, and
              platform of the item.
            </li>
            <li>
              <span className="font-medium">
                Approve items in the weekly plan
              </span>{" "}
              (
              <Link href="/weekly-plan" className="text-signal-700 underline">
                Weekly plan
              </Link>
              ). Nothing is published without explicit approval, even
              for fully connected platforms.
            </li>
          </ol>
        </section>

        {/* ───────────── Per-platform sections ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Per-platform setup
          </h2>
          <p className="text-xs text-ink-500 mt-1 leading-relaxed">
            Status reflects what Signal actually does today, not what
            it promises.
          </p>

          <PlatformSection
            label="Reddit"
            status="automated"
            statusDetail="Scheduler tick publishes to Reddit via the official OAuth API."
            steps={[
              "Open the identity card for the Reddit identity.",
              "Click Connect via official OAuth. You'll be redirected to reddit.com to grant submit permissions.",
              "After OAuth completes, the identity card shows Connected. The scheduler will publish on the scheduled time.",
            ]}
            cautions={[
              "The OAuth scope is limited to posting in subreddits you explicitly choose; we never request inbox or modmail access.",
              "Reddit may rate-limit a new account; expect delays in the first week.",
            ]}
          />

          <PlatformSection
            label="Bluesky"
            status="automated"
            statusDetail="Scheduler tick publishes via AT Protocol with a per-identity encrypted app password."
            steps={[
              "Create a Bluesky app password at https://bsky.app/settings/app-passwords. NEVER use your account password.",
              "Open the Bluesky identity card → Manage → enter handle + app password.",
              "Signal verifies the credentials, encrypts the app password, and stores it under this identity only.",
            ]}
            cautions={[
              "Use a fresh app password per identity. Revoke it in Bluesky's settings if you ever rotate credentials.",
              "Threads and media post creatives go through the standard approval gate (alt text required).",
            ]}
          />

          <PlatformSection
            label="dev.to"
            status="automated"
            statusDetail="Scheduler tick publishes articles via dev.to's REST API with a per-identity encrypted API key."
            steps={[
              "Open https://dev.to/settings/extensions → generate a new API key.",
              "Open the dev.to identity card → Manage → paste the API key.",
              "Verify success on the identity card (a green Connected badge with your dev.to username).",
            ]}
            cautions={[
              "dev.to is article-only. Approval rejects non-article intents before publish.",
              "If you rotate the dev.to API key, repeat step 2 to re-store the new value.",
            ]}
          />

          <PlatformSection
            label="Hashnode"
            status="automated"
            statusDetail="Scheduler tick publishes articles via Hashnode's GraphQL API with a per-identity encrypted API key + publication id."
            steps={[
              "Open https://hashnode.com/settings/developer → generate a Personal Access Token.",
              "Open the Hashnode identity card → Manage → paste the token.",
              "Find your publication id at hashnode.com → your blog → Publication Settings → Publication ID, then set it below for each Hashnode identity.",
            ]}
            cautions={[
              "Hashnode retired free GraphQL API access on 2026-05-13. Accounts without the required plan get a redirect that Signal surfaces as 'hashnode_provider_unavailable' — the token is not the problem, the API is.",
              "Hashnode is article-only. Approval rejects non-article intents before publish.",
            ]}
          />

          {/* Hashnode publication-id forms — one per Hashnode identity */}
          {hashnodeIdentities.length > 0 ? (
            <div className="mt-3 space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Hashnode publication ids
              </div>
              {hashnodeIdentities.map((identity) => {
                const conn = connectionByAccountPlatform.get(
                  `${identity.id}|hashnode`,
                );
                const meta = (conn?.metadata ?? null) as
                  | Record<string, unknown>
                  | null;
                const currentPubId =
                  meta && typeof meta.publication_id === "string"
                    ? (meta.publication_id as string)
                    : null;
                const hasKey = conn?.hasAccessToken === true;
                return (
                  <div
                    key={identity.id}
                    className="rounded-md border border-ink-100 bg-white px-3 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink-900">
                          @{identity.handle ?? "(no handle)"}
                        </div>
                        <div className="text-[11px] text-ink-500 mt-0.5">
                          {hasKey
                            ? "API key stored. Scheduler will use it once a publication id is set."
                            : "No API key yet — connect the Hashnode API key on the identity card first."}
                        </div>
                      </div>
                      {currentPubId ? (
                        <span className="badge-neutral text-[10px] whitespace-nowrap">
                          publication id set
                        </span>
                      ) : (
                        <span className="badge-medium text-[10px] whitespace-nowrap">
                          publication id missing
                        </span>
                      )}
                    </div>
                    <HashnodePublicationForm
                      identityId={identity.id}
                      identityHandle={identity.handle ?? identity.id}
                      initialPublicationId={currentPubId}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-ink-500 leading-relaxed">
              No Hashnode identities yet. Add one on{" "}
              <Link href="/accounts" className="text-signal-700 underline">
                Accounts
              </Link>{" "}
              to surface the publication-id form here.
            </p>
          )}

          <PlatformSection
            label="Telegram"
            status="automated"
            statusDetail="Scheduler tick publishes via the Bot API. Workspace-wide bot token; per-identity chat id (channel @username or numeric)."
            steps={[
              "Talk to @BotFather on Telegram → /newbot → get the bot token.",
              "Set TELEGRAM_BOT_TOKEN in the workspace env (ask an administrator).",
              "Add the bot as an admin of each target channel (Telegram → channel → admins → add).",
              "Create one Telegram identity per channel on the Accounts page. The identity's handle is the channel @username or numeric chat id.",
            ]}
            cautions={[
              "The bot token is workspace-wide. Anyone with the env access can publish from it — restrict env access accordingly.",
              "If the bot isn't an admin of the channel, the API returns 403 and Signal records publish_history with the platform_unauthorized reason.",
            ]}
          />

          <PlatformSection
            label="X (Twitter)"
            status="manual"
            statusDetail="OAuth connection works; the publisher itself is not yet wired. Items resolve to 'not_implemented' at the scheduler. Use manual publishing for now."
            steps={[
              "OAuth connect: open the X identity card → Connect via official OAuth.",
              "Until the publisher lands, copy & paste the approved post into x.com manually, then use Record manual publish on /execution/items/[id] to mark it published.",
            ]}
            cautions={[
              "Signal does NOT bypass approval. Every X post still needs the weekly-plan approval before you can record it as published.",
            ]}
          />

          <PlatformSection
            label="LinkedIn"
            status="manual"
            statusDetail="OAuth connection works; the publisher itself is not yet wired. Items resolve to 'not_implemented' at the scheduler. Use manual publishing for now."
            steps={[
              "OAuth connect: open the LinkedIn identity card → Connect via official OAuth.",
              "Copy & paste the approved post into linkedin.com manually, then Record manual publish on the execution detail page.",
            ]}
            cautions={[
              "LinkedIn API approval is gated by their developer portal. We don't publish through unofficial endpoints.",
            ]}
          />

          <PlatformSection
            label="Instagram"
            status="manual"
            statusDetail="Manual-distribution platform. The scheduler never calls Instagram's API. You publish on the native app, then record the result."
            steps={[
              "Create the Instagram identity on Accounts (handle = your Instagram username).",
              "Use the publish detail page to copy the approved caption + creative, post on Instagram, paste the resulting URL back into Record manual publish.",
            ]}
            cautions={[
              "Don't paste cookies, session tokens, or 2FA codes anywhere in Signal. Manual recording is the supported path.",
            ]}
          />

          <PlatformSection
            label="Threads"
            status="manual"
            statusDetail="Manual-distribution platform. Same flow as Instagram: post on the native app, then Record manual publish."
            steps={[
              "Create the Threads identity on Accounts.",
              "Use the publish detail page to copy → post → record.",
            ]}
            cautions={[
              "No Threads OAuth, no Threads automation — Signal treats Threads as a courier today.",
            ]}
          />

          <PlatformSection
            label="YouTube"
            status="manual"
            statusDetail="Manual-distribution platform. The scheduler never uploads to YouTube. Use the publish detail page to record after you upload."
            steps={[
              "Create the YouTube identity on Accounts (handle = your channel @handle).",
              "Upload the video on youtube.com, then Record manual publish with the resulting URL.",
            ]}
            cautions={[
              "Auto-uploads are intentionally out of scope. Video uploads to YouTube require a long-lived OAuth grant that we don't take here.",
            ]}
          />
        </section>

        {/* ───────────── Operators must NOT do ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            What you must NOT do
          </h2>
          <ul className="mt-3 list-disc pl-5 text-sm text-ink-800 space-y-1.5">
            <li>
              Do <span className="font-semibold">not</span> paste account
              passwords, session tokens, cookies, 2FA codes, or recovery
              codes into Signal — for any platform. Signal only takes
              OAuth grants, official API keys, or app passwords issued
              by the platform itself.
            </li>
            <li>
              Do <span className="font-semibold">not</span> share API
              keys between operators or between identities. Each
              identity has its own encrypted credential; sharing one
              breaks the per-identity audit trail.
            </li>
            <li>
              Do <span className="font-semibold">not</span> bypass the
              approval gate. Every published post must go through
              Weekly plan → approval → schedule. Signal will refuse to
              publish anything that isn&apos;t approved.
            </li>
            <li>
              Do <span className="font-semibold">not</span> create
              parallel credential storage outside Signal (a Notion
              page, a shared text file, a chat thread). The encrypted
              column on platform_connections is the only sanctioned
              place.
            </li>
            <li>
              Do <span className="font-semibold">not</span> publish
              internal debugging conversations to public platforms.
              The approval gate is meant to catch this, but it&apos;s
              still a human discipline.
            </li>
            <li>
              Do <span className="font-semibold">not</span> use direct
              SQL to flip status fields, paste credentials into
              metadata columns, or hand-write rows into
              execution_items. The repositories enforce invariants
              the SQL layer doesn&apos;t — bypassing them risks
              silently broken publishes.
            </li>
          </ul>
        </section>

        {/* ───────────── Troubleshooting ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Troubleshooting
          </h2>
          <div className="mt-3 space-y-3 text-sm text-ink-800">
            <Trouble
              title="Scheduled item shows blocked / platform_not_supported"
              body="Either the platform isn't in SCHEDULER_AUTONOMOUS_PLATFORMS (the scheduler short-circuits it) or the item's platform field doesn't match a known platform. For automated platforms (Reddit, Bluesky, dev.to, Hashnode, Telegram), this should not happen — open an issue with the execution_item id."
            />
            <Trouble
              title="Hashnode publish failed with hashnode_provider_unavailable"
              body="Hashnode's free GraphQL API access was retired on 2026-05-13. Free-tier accounts get a redirect Signal surfaces as 'provider_unavailable' — your token is not the problem, the API tier is. Upgrade the Hashnode plan or use manual publishing."
            />
            <Trouble
              title="Hashnode publish failed with hashnode_publication_missing"
              body="The identity has an API key but no publication id yet. Set it above in the per-identity 'Publication id' form. Find the value at hashnode.com → publication → Publication Settings."
            />
            <Trouble
              title="dev.to publish failed with devto_token_invalid"
              body="The stored API key is rejected by dev.to (revoked / regenerated / wrong scope). Open the dev.to identity card → Manage → Re-connect and paste the current API key."
            />
            <Trouble
              title="Bluesky publish failed with session_expired"
              body="The stored Bluesky session refreshed once but couldn't refresh again. Open the Bluesky identity card → Manage → re-enter handle + app password to mint a fresh session."
            />
            <Trouble
              title="Telegram publish failed with platform_unauthorized"
              body="The bot is not an admin of the target channel. Add the bot in Telegram → channel → admins, then retry the scheduled tick."
            />
            <Trouble
              title="Scheduler tick is silent — items stay scheduled forever"
              body="Either workspace_settings.execution_mode is set to 'dry_run' (override → set to 'live' or remove the column) or no contract covers the item's scope. Check /weekly-contracts → confirm an active contract covers (account, product, platform)."
            />
            <Trouble
              title="An approved post needs to be retracted before it publishes"
              body="Open Weekly plan → the item → Cancel approval. The scheduler will skip it on the next tick. After publish, removal must be done on the platform itself (Signal does not delete from the platform)."
            />
          </div>
        </section>

        {/* ───────────── Platform status table ───────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Platform status
          </h2>
          <p className="text-xs text-ink-500 mt-1 leading-relaxed">
            What Signal actually does today, not what it promises.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-ink-500 border-b border-ink-100">
                <tr>
                  <th className="py-2 pr-3 font-medium">Platform</th>
                  <th className="py-2 pr-3 font-medium">Mode</th>
                  <th className="py-2 pr-3 font-medium">Auth</th>
                  <th className="py-2 pr-3 font-medium">Credentials</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 text-ink-800">
                <StatusRow
                  platform="Reddit"
                  mode="Automated"
                  auth="OAuth (official)"
                  credentials="Per-identity OAuth grant (stored encrypted)"
                />
                <StatusRow
                  platform="Bluesky"
                  mode="Automated"
                  auth="App password (per identity)"
                  credentials="Per-identity encrypted session"
                />
                <StatusRow
                  platform="dev.to"
                  mode="Automated"
                  auth="API key (per identity)"
                  credentials="Per-identity encrypted API key"
                />
                <StatusRow
                  platform="Hashnode"
                  mode="Automated"
                  auth="API key + publication id (per identity)"
                  credentials="Per-identity encrypted API key, publication id in connection metadata"
                />
                <StatusRow
                  platform="Telegram"
                  mode="Automated"
                  auth="Bot token (workspace env)"
                  credentials="Workspace-wide bot token; per-identity chat id"
                />
                <StatusRow
                  platform="X"
                  mode="Manual (planned)"
                  auth="OAuth (connection only)"
                  credentials="Publisher not yet wired; record manually"
                />
                <StatusRow
                  platform="LinkedIn"
                  mode="Manual (planned)"
                  auth="OAuth (connection only)"
                  credentials="Publisher not yet wired; record manually"
                />
                <StatusRow
                  platform="Instagram"
                  mode="Manual"
                  auth="None (manual only)"
                  credentials="Operator publishes on the native app; records via Record manual publish"
                />
                <StatusRow
                  platform="Threads"
                  mode="Manual"
                  auth="None (manual only)"
                  credentials="Operator publishes on the native app; records via Record manual publish"
                />
                <StatusRow
                  platform="YouTube"
                  mode="Manual"
                  auth="None (manual only)"
                  credentials="Operator uploads on youtube.com; records via Record manual publish"
                />
              </tbody>
            </table>
          </div>
        </section>

        {/* ───────────── Footer ───────────── */}
        <section className="card p-5 text-[11px] text-ink-500 leading-relaxed">
          Signal never asks for platform passwords, cookies, session
          tokens, 2FA codes, or recovery codes. Per-identity
          credentials are AES-256-GCM encrypted and decrypted only at
          the moment of a scheduled publish. The plaintext value is
          never echoed in any UI surface, log, or response body.
        </section>
      </div>
    </>
  );
}

// =====================================================================
// Helpers
// =====================================================================

function PlatformSection({
  label,
  status,
  statusDetail,
  steps,
  cautions,
}: {
  label: string;
  status: "automated" | "manual";
  statusDetail: string;
  steps: string[];
  cautions: string[];
}) {
  return (
    <div className="mt-4 border-t border-ink-100 pt-4 first:border-t-0 first:pt-0 first:mt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-900">{label}</h3>
        {status === "automated" ? (
          <span className="badge-low text-[10px]">Automated</span>
        ) : (
          <span className="badge-medium text-[10px]">Manual / planned</span>
        )}
      </div>
      <p className="text-[11px] text-ink-600 mt-1 leading-relaxed">
        {statusDetail}
      </p>
      <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        Steps
      </div>
      <ol className="mt-1 list-decimal pl-5 text-xs text-ink-800 space-y-0.5">
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {cautions.length > 0 ? (
        <>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            Cautions
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs text-ink-700 space-y-0.5">
            {cautions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Trouble({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <div className="text-sm font-medium text-ink-900">{title}</div>
      <p className="text-xs text-ink-600 mt-0.5 leading-relaxed">{body}</p>
    </div>
  );
}

function StatusRow({
  platform,
  mode,
  auth,
  credentials,
}: {
  platform: string;
  mode: string;
  auth: string;
  credentials: string;
}) {
  return (
    <tr>
      <td className="py-2 pr-3 font-medium text-ink-900 whitespace-nowrap">
        {platform}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {mode === "Automated" ? (
          <span className="text-emerald-700">{mode}</span>
        ) : (
          <span className="text-amber-700">{mode}</span>
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">{auth}</td>
      <td className="py-2 pr-3">{credentials}</td>
    </tr>
  );
}
