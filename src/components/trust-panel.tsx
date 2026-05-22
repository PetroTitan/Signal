import { LockIcon } from "./icons";
import { TRUST } from "@/lib/trust-copy";

interface TrustPanelProps {
  compact?: boolean;
  includeApproval?: boolean;
}

export function TrustPanel({
  compact = false,
  includeApproval = false,
}: TrustPanelProps) {
  return (
    <div className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3 text-sm">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
          <LockIcon />
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-ink-900">{TRUST.heading}</div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">{TRUST.body}</p>
          {includeApproval ? (
            <p className="text-ink-700 mt-2 leading-relaxed">{TRUST.approval}</p>
          ) : null}
          {compact ? null : (
            <ul className="text-ink-700 mt-2 space-y-0.5 text-xs">
              {TRUST.notListed.map((line) => (
                <li key={line}>· {line}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
