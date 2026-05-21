import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import { PlatformBadge, RiskBadge } from "@/components/badges";
import {
  accountsById,
  currentWeeklyPlan,
  productsById,
  weeklyPlanItems,
} from "@/lib/mock";
import { formatDateRange, formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Weekly plan" };

export default function WeeklyPlanPage() {
  const items = [...weeklyPlanItems].sort(
    (a, b) =>
      new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
  );

  return (
    <>
      <Topbar
        title="Weekly plan"
        description={`Week of ${formatDateRange(currentWeeklyPlan.weekStartIso, currentWeeklyPlan.weekEndIso)} · ${currentWeeklyPlan.itemCount} items · approve once, distribute organically.`}
      />
      <div className="px-6 lg:px-8 py-6 max-w-7xl">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink-50 text-ink-500 text-xs uppercase tracking-wide">
              <tr>
                <Th>Day · time</Th>
                <Th>Platform</Th>
                <Th>Account</Th>
                <Th>Product</Th>
                <Th>Type</Th>
                <Th className="w-2/5">Hook · body preview</Th>
                <Th>CTA</Th>
                <Th>Risk</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="row-divider">
              {items.map((item) => {
                const acc = accountsById[item.accountId];
                const product = productsById[item.productId];
                return (
                  <tr key={item.id} className="hover:bg-ink-50/60">
                    <Td className="font-mono text-xs text-ink-600 whitespace-nowrap">
                      {formatDateTime(item.scheduledFor)}
                    </Td>
                    <Td>
                      <PlatformBadge platform={item.platform} />
                    </Td>
                    <Td className="whitespace-nowrap">
                      <div className="text-ink-900">{acc.displayName}</div>
                      {acc.handle ? (
                        <div className="text-xs text-ink-500">{acc.handle}</div>
                      ) : null}
                    </Td>
                    <Td>{product.name}</Td>
                    <Td className="capitalize text-ink-700">
                      {item.contentType.replace(/_/g, " ")}
                    </Td>
                    <Td>
                      <div className="font-medium text-ink-900">
                        {item.draft.hook}
                      </div>
                      <div className="text-xs text-ink-500 mt-0.5 line-clamp-2 max-w-md">
                        {item.draft.body}
                      </div>
                    </Td>
                    <Td className="text-xs">
                      {item.draft.cta ? (
                        <span className="text-ink-800">{item.draft.cta}</span>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </Td>
                    <Td>
                      <RiskBadge level={item.riskLevel} />
                    </Td>
                    <Td>
                      <StatusBadge status={item.status} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`text-left font-semibold px-4 py-2.5 ${className}`}>
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-4 py-3 align-top ${className}`}>{children}</td>
  );
}

const statusTones: Record<string, string> = {
  draft: "bg-ink-100 text-ink-700",
  pending_approval: "bg-amber-50 text-amber-700",
  approved: "bg-emerald-50 text-emerald-700",
  rejected: "bg-red-50 text-red-700",
  scheduled: "bg-signal-50 text-signal-700",
  published: "bg-ink-100 text-ink-700",
  skipped: "bg-ink-100 text-ink-500",
  backlog: "bg-ink-100 text-ink-500",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${statusTones[status] ?? "badge-neutral"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
