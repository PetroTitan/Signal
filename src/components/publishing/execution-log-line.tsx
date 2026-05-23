"use client";

import { useState } from "react";

/**
 * Founder-readable line for an execution_logs row. Maps the raw
 * event_type onto an icon + headline + supporting context, and
 * tucks the raw metadata behind a "details" disclosure.
 */

export interface ExecutionLogLineRow {
  id: string;
  eventType: string;
  severity: "info" | "warn" | "error" | string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface EventMeta {
  icon: string;
  headline: (row: ExecutionLogLineRow) => string;
  tone: "neutral" | "info" | "success" | "warn" | "danger";
}

const EVENT_MAP: Record<string, EventMeta> = {
  "item.scheduled": {
    icon: "🗓",
    headline: () => "Scheduled for publishing",
    tone: "info",
  },
  "item.ready": {
    icon: "✓",
    headline: () => "Ready to publish",
    tone: "info",
  },
  "item.ready_for_publish": {
    icon: "✓",
    headline: () => "Ready to publish",
    tone: "info",
  },
  "item.ready_for_manual_publish": {
    icon: "✋",
    headline: () => "Prepared for manual publish",
    tone: "info",
  },
  "item.dry_run_finished": {
    icon: "·",
    headline: () => "Dry-run finished — not published",
    tone: "neutral",
  },
  "item.completed": {
    icon: "✓",
    headline: (row) => {
      const sub =
        row.metadata && typeof row.metadata.subreddit === "string"
          ? (row.metadata.subreddit as string)
          : null;
      const method =
        row.metadata && typeof row.metadata.publish_method === "string"
          ? (row.metadata.publish_method as string)
          : null;
      const base = sub ? `Published to r/${sub}` : "Published";
      return method === "manual" ? `${base} (manual)` : base;
    },
    tone: "success",
  },
  "item.blocked": {
    icon: "⛔",
    headline: (row) => {
      const code =
        row.metadata && typeof row.metadata.reason_code === "string"
          ? (row.metadata.reason_code as string)
          : null;
      return code ? `Blocked — ${code.replace(/_/g, " ")}` : "Blocked";
    },
    tone: "danger",
  },
  "item.failed": {
    icon: "✗",
    headline: (row) => {
      const code =
        row.metadata && typeof row.metadata.reason_code === "string"
          ? (row.metadata.reason_code as string)
          : null;
      return code ? `Failed — ${code.replace(/_/g, " ")}` : "Failed";
    },
    tone: "danger",
  },
  "item.skipped": {
    icon: "→",
    headline: () => "Skipped (will retry)",
    tone: "warn",
  },
  "item.paused": {
    icon: "‖",
    headline: () => "Paused",
    tone: "warn",
  },
  "item.cancelled": {
    icon: "·",
    headline: () => "Cancelled",
    tone: "neutral",
  },
};

const TONE_CLASS = {
  neutral: "bg-ink-50 text-ink-600 border-ink-200",
  info: "bg-signal-50 text-signal-700 border-signal-100",
  success: "bg-emerald-50 text-emerald-700 border-emerald-100",
  warn: "bg-amber-50 text-amber-800 border-amber-200",
  danger: "bg-red-50 text-red-800 border-red-200",
};

export function ExecutionLogLine({ row }: { row: ExecutionLogLineRow }) {
  const [open, setOpen] = useState(false);
  const meta = EVENT_MAP[row.eventType];
  const headline = meta ? meta.headline(row) : row.eventType;
  const toneCls = TONE_CLASS[meta?.tone ?? "neutral"];
  const permalink =
    row.metadata && typeof row.metadata.permalink === "string"
      ? (row.metadata.permalink as string)
      : null;
  const externalUrl =
    row.metadata && typeof row.metadata.external_url === "string"
      ? (row.metadata.external_url as string)
      : null;
  const link = permalink ?? externalUrl;

  return (
    <li className="px-4 py-3 border-b border-ink-100 last:border-b-0">
      <div className="flex items-start gap-3">
        <span
          className={`shrink-0 w-6 h-6 grid place-items-center rounded-full border text-[12px] ${toneCls}`}
          aria-hidden
        >
          {meta?.icon ?? "·"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink-900 font-medium">{headline}</div>
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-signal-700 underline break-all"
            >
              {link}
            </a>
          ) : null}
          <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-2">
            <span>{formatTime(row.createdAt)}</span>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="underline text-ink-500 hover:text-ink-700"
            >
              {open ? "Hide details" : "Details"}
            </button>
          </div>
          {open ? (
            <pre className="mt-2 text-[11px] bg-ink-50 border border-ink-100 rounded p-2 overflow-x-auto font-mono">
              {JSON.stringify(
                { event_type: row.eventType, severity: row.severity, message: row.message, metadata: row.metadata },
                null,
                2,
              )}
            </pre>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}
