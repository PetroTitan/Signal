import Link from "next/link";
import {
  FOUNDER_PLATFORMS,
  resolveIdentityPlatformGuidance,
  type FounderPlatform,
} from "@/core/publishing/platform-guidance";
import { readTierOneConfigStatus } from "@/core/publishing/platform-credentials";
import {
  hasTokenEncryptionKey,
  isOAuthProviderConfigured,
  isRedditOauthBlocked,
} from "@/lib/oauth/env";

/**
 * Phase F4.4.1 — "Where Signal can publish today".
 *
 * Replaces the legacy /accounts "Connection setup" panel
 * (Reddit / X / LinkedIn / Encrypted token storage). Reads the same
 * server-side config status the dedicated /settings/publishing-
 * platforms page uses, but presents it in calmer founder language
 * with no env-var names, no "OAuth", and no "token" wording.
 *
 * Each row reads as "Platform — Mode" with a small status chip on
 * the right.
 *
 * Phase 5 hardening: this panel was previously labelling the
 * workspace-level credential check (env-var presence) as "Connected"
 * in green. That conflated workspace integration state with identity
 * authentication state. The panel now distinguishes:
 *
 *   - "Workspace ready" — env-var credentials are configured but
 *      zero identities have authenticated yet. Neutral tone.
 *   - "n/m connected"   — at least one identity is authenticated.
 *      Green tone, with the count visible.
 *   - "Setup needed"    — workspace-level credentials are missing.
 *   - "Manual"          — platform always publishes manually for
 *      this workspace (Reddit pre-API approval; X / LinkedIn /
 *      YouTube / Threads / Instagram distribution; Indie Hackers).
 */

type RowKind = "automated" | "manual_first" | "manual_only" | "not_connected";

interface PlatformRow {
  label: string;
  short: string;
  mode: string;
  status:
    | { kind: "ready"; detail: string }
    | { kind: "workspace_ready"; detail: string }
    | { kind: "manual"; detail: string }
    | { kind: "missing"; detail: string };
  rowKind: RowKind;
}

/**
 * Counts of authenticated identities per platform, sourced from
 * platform_connections joined with growth_accounts. The panel uses
 * these to label the green "Connected" pill only when ≥1 identity
 * is actually authenticated.
 */
export interface IdentityAuthCounts {
  authenticated: number;
  total: number;
}

export interface PublishingCapabilitiesPanelProps {
  /** Per-platform identity auth counts. Missing keys default to 0/0. */
  identityAuthCounts?: Partial<Record<FounderPlatform, IdentityAuthCounts>>;
}

function authedDetail(counts: IdentityAuthCounts | undefined): string {
  const c = counts ?? { authenticated: 0, total: 0 };
  return `${c.authenticated}/${c.total} connected`;
}

export function PublishingCapabilitiesPanel({
  identityAuthCounts,
}: PublishingCapabilitiesPanelProps = {}) {
  const tier1 = readTierOneConfigStatus();
  const redditBlocked = isRedditOauthBlocked();
  // Phase F9 — X OAuth readiness is the AND of provider env +
  // encryption. Used by the X row to decide between
  // "Workspace ready · no identity connected" and "Setup needed".
  const xConfigured =
    isOAuthProviderConfigured("x") && hasTokenEncryptionKey();
  const counts = identityAuthCounts ?? {};

  const rows: PlatformRow[] = FOUNDER_PLATFORMS.map((p) => {
    const meta = resolveIdentityPlatformGuidance(p);
    const label = meta?.label ?? p;
    const short = meta?.short ?? p.slice(0, 2);

    // Helper closure: workspace-level configured + per-identity auth
    // counts → row. "Connected" (green) only fires when at least one
    // identity is authenticated; workspace-credentials-present-but-
    // no-identity-yet renders as the neutral "Workspace ready" tone.
    const apiRow = (configured: boolean): PlatformRow => {
      if (!configured) {
        return {
          label,
          short,
          mode: "Automated when connected",
          status: { kind: "missing", detail: "Setup needed" },
          rowKind: "not_connected",
        };
      }
      const c = counts[p];
      const authed = c?.authenticated ?? 0;
      if (authed > 0) {
        return {
          label,
          short,
          mode: "Automated when connected",
          status: { kind: "ready", detail: authedDetail(c) },
          rowKind: "automated",
        };
      }
      return {
        label,
        short,
        mode: "Automated when connected",
        status: { kind: "workspace_ready", detail: "Workspace ready · no identity connected" },
        rowKind: "not_connected",
      };
    };

    if (p === "devto") return apiRow(tier1.devto.configured);
    if (p === "hashnode") return apiRow(tier1.hashnode.configured);
    if (p === "bluesky") return apiRow(tier1.bluesky.configured);
    if (p === "reddit") {
      return {
        label,
        short,
        mode: redditBlocked
          ? "Manual — API approval pending"
          : "Manual-first",
        status: {
          kind: "manual",
          detail: redditBlocked ? "Manual mode" : "Manual-first",
        },
        rowKind: "manual_first",
      };
    }
    if (p === "x") {
      // Phase F9 — X is automated via OAuth 2.0 + /2/tweets.
      // Capabilities row mirrors the dev.to / Bluesky pattern: shows
      // "Setup needed" when env is missing, "Workspace ready · no
      // identity connected" once env is in place but no identity has
      // signed in yet, and "Connected" once at least one identity
      // has completed OAuth.
      return apiRow(xConfigured);
    }
    if (
      p === "linkedin" ||
      p === "youtube" ||
      p === "threads" ||
      p === "instagram"
    ) {
      // F5.0 + F5.1 — distribution layers. Signal prepares the post
      // and opens the native composer; the founder publishes on the
      // platform itself.
      return {
        label,
        short,
        mode: "Manual distribution",
        status: { kind: "manual", detail: "Manual distribution" },
        rowKind: "manual_first",
      };
    }
    if (p === "telegram") {
      // F5.1 — semi-automated via Telegram Bot API. The bot only
      // posts to channels the founder explicitly configured.
      if (!tier1.telegram.configured) {
        return {
          label,
          short,
          mode: "Automated when bot is admin",
          status: { kind: "missing", detail: "Setup needed" },
          rowKind: "not_connected",
        };
      }
      const c = counts[p];
      const authed = c?.authenticated ?? 0;
      if (authed > 0) {
        return {
          label,
          short,
          mode: "Automated when bot is admin",
          status: { kind: "ready", detail: authedDetail(c) },
          rowKind: "automated",
        };
      }
      return {
        label,
        short,
        mode: "Automated when bot is admin",
        status: {
          kind: "workspace_ready",
          detail: "Workspace ready · no channel connected",
        },
        rowKind: "not_connected",
      };
    }
    // indie_hackers
    return {
      label,
      short,
      mode: "Manual",
      status: { kind: "manual", detail: "Manual" },
      rowKind: "manual_only",
    };
  });

  return (
    <section className="rounded-2xl border border-ink-200 bg-white">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">
            Where Signal can publish today
          </h2>
          <p className="text-[11px] text-ink-500 mt-0.5 leading-relaxed">
            Connection status across the platforms Signal supports.
          </p>
        </div>
        <Link
          href="/settings/publishing-platforms"
          className="text-[11px] text-signal-700 hover:text-signal-800 whitespace-nowrap shrink-0"
        >
          Manage →
        </Link>
      </header>
      <ul className="row-divider">
        {rows.map((row) => (
          <li
            key={row.label}
            className="px-5 py-3 flex items-center gap-3"
          >
            <span
              className="w-6 h-6 rounded-md bg-ink-100 text-ink-700 grid place-items-center text-[10px] font-mono shrink-0"
              aria-hidden
            >
              {row.short}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm text-ink-900">{row.label}</div>
              <div className="text-[11px] text-ink-500">{row.mode}</div>
            </div>
            <StatusBadge kind={row.status.kind} detail={row.status.detail} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusBadge({
  kind,
  detail,
}: {
  kind: "ready" | "workspace_ready" | "manual" | "missing";
  detail: string;
}) {
  // "workspace_ready" is a deliberately neutral tone (signal-blue),
  // not green. The workspace has the credentials it needs, but no
  // identity is authenticated yet — this is not the same state as
  // an identity actively being connected.
  const tone =
    kind === "ready"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : kind === "workspace_ready"
        ? "bg-signal-50 text-signal-700 border-signal-200"
        : kind === "manual"
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : "bg-ink-50 text-ink-500 border-ink-200";
  const dot =
    kind === "ready"
      ? "bg-emerald-500"
      : kind === "workspace_ready"
        ? "bg-signal-500"
        : kind === "manual"
          ? "bg-amber-500"
          : "bg-ink-300";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium shrink-0 ${tone}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {detail}
    </span>
  );
}
