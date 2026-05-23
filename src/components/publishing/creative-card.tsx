import type {
  CreativeSourceType,
  CreativeStatus,
  CreativeType,
} from "@/lib/supabase/types";
import {
  CreativeSourceBadge,
  CreativeStatusBadge,
  CreativeTypeBadge,
} from "./creative-source-badge";

/**
 * Visual creative card. Replaces the older "metadata row" look with
 * a tile that leads with the actual media and surfaces the badges
 * an operator scans for: source, type, approval status, alt text.
 *
 * Server component by default; the parent decides whether to embed
 * it inside a client editor.
 */

export interface CreativeCardData {
  id: string;
  creativeType: CreativeType;
  sourceType: CreativeSourceType;
  status: CreativeStatus;
  assetUrl: string | null;
  sourceUrl: string | null;
  altText: string | null;
  license: string | null;
  attribution: string | null;
  prompt: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string | null;
}

export interface CreativeCardProps {
  creative: CreativeCardData | null;
  /** Visual density. "compact" for list rows, "comfortable" for detail. */
  density?: "compact" | "comfortable";
  /** Optional inline actions shown in the card footer. */
  actions?: React.ReactNode;
}

export function CreativeCard({
  creative,
  density = "compact",
  actions,
}: CreativeCardProps) {
  if (!creative) {
    return <CreativeEmptyCard density={density} />;
  }

  const isVideo =
    creative.creativeType === "video" ||
    creative.mimeType === "video/mp4" ||
    creative.mimeType === "video/webm";
  const hasMedia = creative.assetUrl !== null;
  const previewUrl = creative.assetUrl;

  return (
    <div className="rounded-xl border border-ink-200 bg-white overflow-hidden">
      <div className="relative aspect-[4/3] bg-ink-50 flex items-center justify-center">
        {hasMedia && previewUrl ? (
          isVideo ? (
            <video
              src={previewUrl}
              muted
              playsInline
              preload="metadata"
              className="w-full h-full object-cover"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt={creative.altText ?? ""}
              className="w-full h-full object-cover"
            />
          )
        ) : (
          <NoMediaPlaceholder
            sourceType={creative.sourceType}
            prompt={creative.prompt}
          />
        )}
        <div className="absolute top-2 left-2 flex flex-wrap gap-1">
          <CreativeSourceBadge source={creative.sourceType} />
          <CreativeTypeBadge type={creative.creativeType} />
        </div>
        <div className="absolute top-2 right-2">
          <CreativeStatusBadge status={creative.status} />
        </div>
      </div>

      <div className={density === "comfortable" ? "p-4 space-y-2" : "p-3 space-y-1.5"}>
        {creative.altText ? (
          <p className="text-xs text-ink-700 leading-relaxed line-clamp-2">
            <span className="font-semibold text-ink-500">Alt: </span>
            {creative.altText}
          </p>
        ) : (
          <p className="text-xs text-amber-700 italic">
            Alt text missing — required before publish.
          </p>
        )}

        {(creative.license || creative.attribution || creative.sourceUrl) ? (
          <div className="text-[11px] text-ink-500 space-y-0.5">
            {creative.attribution ? <div>{creative.attribution}</div> : null}
            {creative.license ? (
              <div>
                <span className="text-ink-400">License:</span> {creative.license}
              </div>
            ) : null}
            {creative.sourceUrl ? (
              <a
                href={creative.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-signal-700 underline break-all"
              >
                source ↗
              </a>
            ) : null}
          </div>
        ) : null}

        {density === "comfortable" ? (
          <div className="text-[11px] text-ink-400 flex flex-wrap gap-x-3">
            {creative.mimeType ? <span>{creative.mimeType}</span> : null}
            {typeof creative.sizeBytes === "number" ? (
              <span>{formatBytes(creative.sizeBytes)}</span>
            ) : null}
            {creative.uploadedAt ? (
              <span>uploaded {formatDate(creative.uploadedAt)}</span>
            ) : null}
          </div>
        ) : null}

        {actions ? <div className="pt-1">{actions}</div> : null}
      </div>
    </div>
  );
}

function NoMediaPlaceholder({
  sourceType,
  prompt,
}: {
  sourceType: CreativeSourceType;
  prompt: string | null;
}) {
  return (
    <div className="text-center px-4 py-6">
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">
        {sourceType === "generated" && prompt
          ? "Generated creative"
          : sourceType === "planned"
            ? "Placeholder"
            : "No media attached"}
      </div>
      {prompt ? (
        <p className="text-xs text-ink-700 leading-relaxed line-clamp-3 italic">
          “{prompt}”
        </p>
      ) : (
        <p className="text-xs text-ink-500">
          Attach a file or link to a hosted asset.
        </p>
      )}
    </div>
  );
}

function CreativeEmptyCard({ density }: { density: "compact" | "comfortable" }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 text-center">
      <div className={density === "comfortable" ? "p-6 space-y-2" : "p-4 space-y-1"}>
        <div className="text-sm font-medium text-ink-800">
          No creative attached yet
        </div>
        <p className="text-xs text-ink-500 leading-relaxed max-w-sm mx-auto">
          This post cannot be published until a creative is approved.
          Attach an image, video, screenshot, or generated visual.
        </p>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
