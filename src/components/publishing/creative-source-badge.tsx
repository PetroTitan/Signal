import type {
  CreativeSourceType,
  CreativeStatus,
  CreativeType,
} from "@/lib/supabase/types";

/**
 * Visual badge for the *source* of a creative (where it came from).
 * Distinct from the readiness badge ("approved" / "needs review").
 *
 * Tones stay calm — Linear/Stripe-ish, not loud dashboard colors.
 */

const SOURCE_META: Record<
  CreativeSourceType,
  { label: string; tone: string; description: string }
> = {
  uploaded: {
    label: "Uploaded",
    tone: "bg-signal-50 text-signal-700 border-signal-100",
    description: "Operator-uploaded file",
  },
  generated: {
    label: "Generated",
    tone: "bg-violet-50 text-violet-700 border-violet-100",
    description: "AI-generated asset",
  },
  wikimedia: {
    label: "Wikimedia",
    tone: "bg-amber-50 text-amber-700 border-amber-100",
    description: "Wikimedia / public-domain / CC asset",
  },
  official_source: {
    label: "Official",
    tone: "bg-emerald-50 text-emerald-700 border-emerald-100",
    description: "Official product screenshot or marketing asset",
  },
  manual_url: {
    label: "URL",
    tone: "bg-ink-50 text-ink-700 border-ink-200",
    description: "Manually-provided URL with license notes",
  },
  planned: {
    label: "Planned",
    tone: "bg-ink-50 text-ink-500 border-dashed border-ink-300",
    description: "Placeholder — not publishable yet",
  },
};

export function CreativeSourceBadge({
  source,
}: {
  source: CreativeSourceType;
}) {
  const meta = SOURCE_META[source];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.tone}`}
      title={meta.description}
    >
      {meta.label}
    </span>
  );
}

const CREATIVE_TYPE_LABELS: Record<CreativeType, string> = {
  image: "Image",
  video: "Video",
  animation: "Animation",
};

export function CreativeTypeBadge({ type }: { type: CreativeType }) {
  return (
    <span className="inline-flex items-center rounded-full border border-ink-200 bg-white px-2 py-0.5 text-[10px] font-medium text-ink-700">
      {CREATIVE_TYPE_LABELS[type]}
    </span>
  );
}

const STATUS_META: Record<
  CreativeStatus,
  { label: string; tone: string }
> = {
  planned: { label: "Planned", tone: "bg-ink-50 text-ink-500 border-ink-200" },
  pending_review: {
    label: "Needs review",
    tone: "bg-amber-50 text-amber-700 border-amber-200",
  },
  approved: {
    label: "Approved",
    tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  rejected: {
    label: "Rejected",
    tone: "bg-red-50 text-red-700 border-red-200",
  },
};

export function CreativeStatusBadge({ status }: { status: CreativeStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.tone}`}
    >
      {meta.label}
    </span>
  );
}
