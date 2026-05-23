/**
 * Phase F2.9.7 — visual wrapper for a connected publishing account.
 *
 * Replaces the OAuth-row look on /accounts with a creator-identity
 * card: platform avatar tile, handle/display name, connection
 * health pill, last publish, last health check, and the connect /
 * disconnect controls.
 *
 * This is a server component — the action buttons live inside
 * `ConnectionControls` (client). The card itself just composes the
 * visual hierarchy.
 */

import type { PlatformConnectionConnectionStatus } from "@/core/platform-oauth";

export type AccountConnectionState =
  | "not_connected"
  | "connected"
  | "expired"
  | "revoked"
  | "error"
  | "disabled"
  | "reauthorization_required";

const STATE_META: Record<
  AccountConnectionState,
  { label: string; tone: "info" | "success" | "warn" | "danger" | "muted" }
> = {
  not_connected: { label: "Not connected", tone: "muted" },
  connected: { label: "Connected", tone: "success" },
  expired: { label: "Token expired", tone: "warn" },
  revoked: { label: "Revoked", tone: "muted" },
  error: { label: "Connection error", tone: "danger" },
  disabled: { label: "Disabled", tone: "muted" },
  reauthorization_required: {
    label: "Needs reauthorization",
    tone: "warn",
  },
};

const TONE = {
  info: "bg-signal-50 text-signal-700 border-signal-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  muted: "bg-ink-50 text-ink-500 border-ink-200",
} as const;

const TONE_DOT = {
  info: "bg-signal-500",
  success: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-ink-300",
} as const;

export function ConnectionStatePill({
  state,
}: {
  state: AccountConnectionState | PlatformConnectionConnectionStatus;
}) {
  const meta = STATE_META[state] ?? STATE_META.not_connected;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE[meta.tone]}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${TONE_DOT[meta.tone]}`}
        aria-hidden
      />
      {meta.label}
    </span>
  );
}

export interface AccountIdentityCardProps {
  platform: "reddit" | "x" | "linkedin" | string;
  displayName: string | null;
  handle: string | null;
  connectionState: AccountConnectionState | PlatformConnectionConnectionStatus;
  lastPublishedAt: string | null;
  lastCheckedAt: string | null;
  /** Operator notes — kept calm; max ~1 short line. */
  notes?: string | null;
  /** Right-hand controls (Connect / Reauthorize / Disconnect / Check). */
  controls?: React.ReactNode;
  /** Optional inline note about safe-mode or API approval status. */
  helperNote?: string | null;
  /** Archive control rendered in the bottom corner. */
  archiveControl?: React.ReactNode;
  /** F4.4 — voice profile editor / display slot. */
  voiceProfile?: React.ReactNode;
}

export function AccountIdentityCard(props: AccountIdentityCardProps) {
  const platformLabel =
    props.platform === "reddit"
      ? "Reddit"
      : props.platform === "devto"
        ? "dev.to"
        : props.platform === "hashnode"
          ? "Hashnode"
          : props.platform === "bluesky"
            ? "Bluesky"
            : props.platform === "indie_hackers"
              ? "Indie Hackers"
              : props.platform === "x"
                ? "X"
                : props.platform === "linkedin"
                  ? "LinkedIn"
                  : props.platform;
  const tile = platformAvatar(props.platform);

  return (
    <article className="rounded-2xl border border-ink-200 bg-white overflow-hidden">
      <div className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          <div
            className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 ${tile.bg} ${tile.text} font-bold`}
            aria-hidden
          >
            {tile.label}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-ink-900 truncate">
                  {props.handle
                    ? props.platform === "reddit"
                      ? `u/${stripHandlePrefix(props.handle)}`
                      : props.handle
                    : (props.displayName ?? "Unnamed account")}
                </h3>
                <div className="text-[11px] text-ink-500 mt-0.5">
                  {platformLabel}
                  {props.displayName &&
                  props.handle &&
                  props.displayName !== props.handle ? (
                    <>
                      {" · "}
                      <span className="text-ink-600">{props.displayName}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <ConnectionStatePill state={props.connectionState} />
            </div>

            {props.helperNote ? (
              <p className="text-[11px] text-amber-700 leading-relaxed mt-2">
                {props.helperNote}
              </p>
            ) : null}

            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-ink-500">Last published</dt>
              <dd className="text-ink-800">
                {formatRelative(props.lastPublishedAt) ?? "—"}
              </dd>
              <dt className="text-ink-500">Last checked</dt>
              <dd className="text-ink-800">
                {formatRelative(props.lastCheckedAt) ?? "—"}
              </dd>
            </dl>

            {props.notes ? (
              <p className="text-[11px] text-ink-500 leading-relaxed mt-2 italic line-clamp-1">
                {props.notes}
              </p>
            ) : null}
          </div>
        </div>

        {props.voiceProfile ? (
          <div className="mt-3 pt-3 border-t border-ink-100">
            {props.voiceProfile}
          </div>
        ) : null}

        {props.controls ? (
          <div className="mt-3 pt-3 border-t border-ink-100">
            {props.controls}
          </div>
        ) : null}
      </div>

      {props.archiveControl ? (
        <div className="px-4 md:px-5 py-2 border-t border-ink-100 bg-ink-50/40 flex justify-end">
          {props.archiveControl}
        </div>
      ) : null}
    </article>
  );
}

function platformAvatar(platform: string): { bg: string; text: string; label: string } {
  switch (platform) {
    case "reddit":
      return { bg: "bg-orange-100", text: "text-orange-700", label: "r/" };
    case "devto":
      return { bg: "bg-ink-100", text: "text-ink-800", label: "dev" };
    case "hashnode":
      return { bg: "bg-blue-100", text: "text-blue-800", label: "Hn" };
    case "bluesky":
      return { bg: "bg-sky-100", text: "text-sky-700", label: "Bs" };
    case "indie_hackers":
      return { bg: "bg-violet-100", text: "text-violet-700", label: "IH" };
    case "x":
      return { bg: "bg-ink-900", text: "text-white", label: "X" };
    case "linkedin":
      return { bg: "bg-blue-50", text: "text-blue-700", label: "in" };
    default:
      return { bg: "bg-ink-100", text: "text-ink-700", label: platform.slice(0, 2) };
  }
}

function stripHandlePrefix(handle: string): string {
  return handle.replace(/^u\//i, "").replace(/^@/, "");
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  const minutes = ms / (60 * 1000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
