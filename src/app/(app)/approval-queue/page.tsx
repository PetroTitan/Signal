import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import {
  accountsById,
  productsById,
  weeklyPlanItems,
} from "@/lib/mock";
import { formatDateTime, relativeFromNow } from "@/lib/format";

export const metadata: Metadata = { title: "Approval queue" };

const actions: { label: string; tone?: "default" | "primary" | "ghost"; hint?: string }[] = [
  { label: "Approve", tone: "primary" },
  { label: "Edit" },
  { label: "Rewrite softer" },
  { label: "Remove link" },
  { label: "Delay" },
  { label: "Convert to comment" },
  { label: "Save to backlog" },
  { label: "Reject", tone: "ghost" },
];

export default function ApprovalQueuePage() {
  const pending = weeklyPlanItems.filter(
    (i) => i.status === "pending_approval",
  );
  const lowRiskPending = pending.filter((i) => i.riskLevel === "low").length;

  return (
    <>
      <Topbar
        title="Approval queue"
        description="One calm weekly review. Decisions are deliberate, not aggressive."
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={lowRiskPending === 0}
            >
              Approve all low-risk ({lowRiskPending})
            </button>
            <button type="button" className="btn-primary">
              Approve plan
            </button>
          </>
        }
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-4">
        {pending.length === 0 ? (
          <div className="card-padded text-sm text-ink-500">
            Queue is clear. Nothing pending.
          </div>
        ) : (
          pending.map((item) => {
            const acc = accountsById[item.accountId];
            const product = productsById[item.productId];
            return (
              <article key={item.id} className="card">
                <header className="px-5 py-3.5 border-b border-ink-100 flex items-center gap-2 flex-wrap">
                  <PlatformBadge platform={item.platform} />
                  <span className="text-sm text-ink-800 font-medium">
                    {acc.displayName}
                  </span>
                  <span className="text-xs text-ink-500">· {product.name}</span>
                  <span className="text-xs text-ink-500">
                    · {item.contentType.replace(/_/g, " ")}
                  </span>
                  <span className="ml-auto text-xs text-ink-500">
                    {formatDateTime(item.scheduledFor)} ·{" "}
                    {relativeFromNow(item.scheduledFor)}
                  </span>
                  <RiskBadge level={item.riskLevel} />
                </header>

                <div className="px-5 py-4">
                  <div className="text-base font-semibold text-ink-900">
                    {item.draft.hook}
                  </div>
                  <p className="text-sm text-ink-700 mt-2 leading-relaxed whitespace-pre-line">
                    {item.draft.body}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.draft.cta ? (
                      <span className="text-xs text-ink-600">
                        <span className="text-ink-400">CTA · </span>
                        {item.draft.cta}
                      </span>
                    ) : (
                      <span className="text-xs text-ink-500">No CTA</span>
                    )}
                  </div>

                  {item.riskNotes.length > 0 ? (
                    <div className="mt-3 border-t border-ink-100 pt-3">
                      <div className="stat-label mb-1">Risk notes</div>
                      <ul className="text-sm text-ink-700 space-y-1">
                        {item.riskNotes.map((n) => (
                          <li key={n}>· {n}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <footer className="px-5 py-3 border-t border-ink-100 flex flex-wrap gap-2 bg-ink-50/40">
                  {actions.map((a) => {
                    const cls =
                      a.tone === "primary"
                        ? "btn-primary"
                        : a.tone === "ghost"
                          ? "btn-ghost"
                          : "btn";
                    return (
                      <button key={a.label} type="button" className={cls}>
                        {a.label}
                      </button>
                    );
                  })}
                </footer>
              </article>
            );
          })
        )}
      </div>
    </>
  );
}
