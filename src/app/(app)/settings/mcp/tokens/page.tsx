import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listOperatorTokens } from "@/repositories/mcp-server/operator-token-repository";
import { ALLOWED_SCOPES, SCOPE_LABELS } from "@/mcp/permissions";
import { CreateTokenForm } from "./_create-form";
import { RevokeTokenButton } from "./_revoke-button";

export const dynamic = "force-dynamic";

export default async function McpTokensPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="MCP operator tokens"
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
        <Topbar title="MCP operator tokens" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }
  const tokens = await listOperatorTokens(membership.workspace.id);

  return (
    <>
      <Topbar
        title="MCP operator tokens"
        description="Bearer tokens external assistants use to call the Signal MCP server."
        actions={
          <Link href="/settings/mcp" className="btn-secondary text-xs">
            ← Back to MCP operations
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">How tokens work</h2>
          <p className="text-xs text-ink-700 mt-1 leading-relaxed">
            A token is shown <strong>once</strong> on creation. Signal stores
            only its SHA-256 hash. Configure your assistant (Claude Code,
            Codex) with the token; do not commit it to the repo.
          </p>
          <p className="text-xs text-ink-700 mt-2 leading-relaxed">
            Scopes are additive. The token can only call tools whose
            <code className="font-mono text-[11px]"> required_scopes </code>
            are fully present on the token.
          </p>
        </section>

        <CreateTokenForm
          scopes={ALLOWED_SCOPES.map((s) => ({
            scope: s,
            label: SCOPE_LABELS[s],
          }))}
        />

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">Tokens</div>
            <div className="text-xs text-ink-500">{tokens.length} total</div>
          </header>
          {tokens.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No tokens yet. Create one above.
            </div>
          ) : (
            <ul className="row-divider">
              {tokens.map((t) => (
                <li
                  key={t.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900">
                      {t.name}
                    </div>
                    <div className="text-[11px] text-ink-500 mt-0.5">
                      preview <code className="font-mono">{t.tokenPreview}…</code>{" "}
                      · {t.scopes.length} scope(s)
                    </div>
                    <div className="text-[11px] text-ink-400 mt-0.5">
                      created {t.createdAt.slice(0, 19).replace("T", " ")}
                      {t.lastUsedAt
                        ? ` · last used ${t.lastUsedAt.slice(0, 19).replace("T", " ")}`
                        : ""}
                      {t.expiresAt
                        ? ` · expires ${t.expiresAt.slice(0, 19).replace("T", " ")}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={
                        t.status === "active"
                          ? "badge-neutral text-[10px] text-green-700"
                          : "badge-neutral text-[10px] text-ink-500"
                      }
                    >
                      {t.status}
                    </span>
                    {t.status === "active" ? (
                      <RevokeTokenButton tokenId={t.id} />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5 text-[11px] text-ink-500 leading-relaxed">
          The Signal MCP HTTP bridge endpoint is{" "}
          <code className="font-mono">/api/mcp</code>. See{" "}
          <code className="font-mono">docs/mcp-server/</code> for client
          configuration.
        </section>
      </div>
    </>
  );
}
