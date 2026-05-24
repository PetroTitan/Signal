import { headers } from "next/headers";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listOperatorTokens } from "@/repositories/mcp-server/operator-token-repository";
import { FOUNDER_PERMISSION_GROUPS, describeScopesAsGroups } from "@/mcp/founder-permissions";
import { resolveMcpEndpoint } from "@/mcp/snippets";
import {
  deriveTokenState,
  relativeTime,
  tokenStateLabel,
  tokenStateTone,
} from "@/mcp/token-state";
import { CreateTokenForm } from "./_create-form";
import { RevokeTokenButton } from "./_revoke-button";
import { RenameTokenButton } from "./_rename-button";

export const dynamic = "force-dynamic";

export default async function McpTokensPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Assistant access"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase first.
        </div>
      </>
    );
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Assistant access" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }

  const tokens = await listOperatorTokens(membership.workspace.id);
  const endpoint = resolveMcpEndpoint(headers());

  const activeTokens = tokens.filter(
    (t) => t.status !== "revoked" && t.status !== "expired",
  );
  const archivedTokens = tokens.filter(
    (t) => t.status === "revoked" || t.status === "expired",
  );

  return (
    <>
      <Topbar
        title="Assistant access"
        description="Connect Claude Code, Codex, or another MCP client to this workspace. Publishing still requires your approval."
        actions={
          <Link href="/settings/mcp" className="btn-ghost text-xs">
            ← Back to MCP
          </Link>
        }
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        <section className="rounded-2xl border border-ink-200 bg-white p-4 text-xs text-ink-700 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-1 text-sm">
            How this works
          </div>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Create a token below.</li>
            <li>Copy the snippet into Claude Code or Codex.</li>
            <li>The assistant can read this workspace and prepare drafts.</li>
            <li>You approve before anything publishes.</li>
          </ol>
          <p className="text-[11px] text-ink-500 mt-2 leading-relaxed">
            Tokens are shown once. Signal stores only a SHA-256 hash. You can
            revoke any token at any time — the assistant disconnects on its
            next request.
          </p>
        </section>

        <CreateTokenForm endpoint={endpoint} groups={FOUNDER_PERMISSION_GROUPS} />

        <section className="rounded-2xl border border-ink-200 bg-white">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-baseline justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Active tokens
              </div>
              <p className="text-[11px] text-ink-500 mt-0.5">
                {activeTokens.length} active · {tokens.length} total
              </p>
            </div>
            <div className="text-[11px] text-ink-500">
              Endpoint:{" "}
              <code className="font-mono text-[10px]">{endpoint}</code>
            </div>
          </header>
          {activeTokens.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No active tokens. Create one above to connect an assistant.
            </div>
          ) : (
            <ul className="row-divider">
              {activeTokens.map((token) => (
                <TokenListRow key={token.id} token={token} />
              ))}
            </ul>
          )}
        </section>

        {archivedTokens.length > 0 ? (
          <details className="rounded-2xl border border-ink-200 bg-white">
            <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
              Revoked + expired ({archivedTokens.length})
            </summary>
            <ul className="row-divider">
              {archivedTokens.map((token) => (
                <TokenListRow key={token.id} token={token} archived />
              ))}
            </ul>
          </details>
        ) : null}

        <section className="rounded-2xl border border-ink-200 bg-white p-4 text-[11px] text-ink-600 leading-relaxed space-y-1">
          <div className="font-semibold text-ink-800 text-xs mb-0.5">
            Assistants cannot
          </div>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Publish to any platform on their own.</li>
            <li>Read platform passwords, cookies, or session tokens.</li>
            <li>Create live social accounts.</li>
            <li>Bypass your approval on the weekly plan.</li>
          </ul>
        </section>
      </div>
    </>
  );
}

function TokenListRow({
  token,
  archived = false,
}: {
  token: Awaited<ReturnType<typeof listOperatorTokens>>[number];
  archived?: boolean;
}) {
  const state = deriveTokenState(token);
  const stateLabel = tokenStateLabel(state);
  const tone = tokenStateTone(state);
  const lastUsed = relativeTime(token.lastUsedAt);
  const groupLabels = describeScopesAsGroups(token.scopes);

  return (
    <li className="px-5 py-3.5 flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-ink-900 break-all">
            {token.name}
          </span>
          {!archived ? (
            <RenameTokenButton
              tokenId={token.id}
              initialName={token.name}
            />
          ) : null}
        </div>
        <div className="text-[11px] text-ink-500 mt-0.5">
          {token.assistantLabel ?? "Custom"} ·{" "}
          <code className="font-mono">{token.tokenPreview}…</code>
        </div>
        {groupLabels.length > 0 ? (
          <div className="text-[11px] text-ink-500 mt-0.5">
            {groupLabels.join(" · ")}
          </div>
        ) : (
          <div className="text-[11px] text-ink-400 mt-0.5">
            {token.scopes.length} raw scope
            {token.scopes.length === 1 ? "" : "s"}
          </div>
        )}
        <div className="text-[11px] text-ink-400 mt-0.5">
          Created{" "}
          {new Date(token.createdAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          {lastUsed ? <> · Last used {lastUsed}</> : null}
          {token.expiresAt ? (
            <>
              {" "}· Expires{" "}
              {new Date(token.expiresAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5 shrink-0">
        <StateBadge label={stateLabel} tone={tone} />
        {!archived ? <RevokeTokenButton tokenId={token.id} /> : null}
      </div>
    </li>
  );
}

function StateBadge({
  label,
  tone,
}: {
  label: string;
  tone: "success" | "warn" | "muted" | "danger";
}) {
  const cls =
    tone === "success"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : tone === "warn"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : tone === "danger"
          ? "bg-red-50 text-red-700 border-red-200"
          : "bg-ink-50 text-ink-500 border-ink-200";
  const dot =
    tone === "success"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "danger"
          ? "bg-red-500"
          : "bg-ink-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
