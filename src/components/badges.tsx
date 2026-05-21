import type { AccountStatus, PlatformId, RiskLevel } from "@/types";

export function PlatformBadge({ platform }: { platform: PlatformId }) {
  const label =
    platform === "reddit" ? "Reddit" : platform === "x" ? "X" : "LinkedIn";
  const tone =
    platform === "reddit"
      ? "bg-orange-50 text-orange-700"
      : platform === "x"
        ? "bg-ink-900 text-white"
        : "bg-blue-50 text-blue-700";
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function RiskBadge({ level, score }: { level: RiskLevel; score?: number }) {
  const cls =
    level === "low"
      ? "badge-low"
      : level === "medium"
        ? "badge-medium"
        : level === "high"
          ? "badge-high"
          : "badge bg-ink-900 text-white";
  const baseLabel =
    level === "blocked" ? "Blocked" : level.charAt(0).toUpperCase() + level.slice(1) + " risk";
  const label = typeof score === "number" ? `${baseLabel} · ${score}` : baseLabel;
  return <span className={cls}>{label}</span>;
}

const statusTones: Record<AccountStatus, string> = {
  planned: "bg-ink-100 text-ink-700",
  setup_needed: "bg-ink-100 text-ink-700",
  awaiting_manual_creation: "bg-amber-50 text-amber-700",
  ready_to_connect: "bg-signal-50 text-signal-700",
  connected: "bg-signal-50 text-signal-700",
  warming: "bg-amber-50 text-amber-700",
  active: "bg-emerald-50 text-emerald-700",
  paused: "bg-ink-100 text-ink-700",
};

const statusLabels: Record<AccountStatus, string> = {
  planned: "Planned",
  setup_needed: "Setup needed",
  awaiting_manual_creation: "Awaiting manual creation",
  ready_to_connect: "Ready to connect",
  connected: "Connected",
  warming: "Warming",
  active: "Active",
  paused: "Paused",
};

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  return (
    <span className={`badge ${statusTones[status]}`}>
      {statusLabels[status]}
    </span>
  );
}
