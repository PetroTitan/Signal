import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  listNotificationsPage,
  type NotificationRecord,
} from "@/repositories/notification-repository";
import { getNotificationPreferences } from "@/repositories/notification-preferences-repository";
import { syncOperationalNotifications } from "@/core/notifications/sync-notifications";
import { gatherDigestCounts } from "@/core/notifications/digest-data";
import { buildOperationalDigest } from "@/core/notifications/notification-builder";
import type { NotificationStatus, NotificationType } from "@/lib/supabase/types";
import {
  DigestControls,
  MarkAllReadButton,
  NotificationRowActions,
  PreferencesForm,
} from "./_client";

export const dynamic = "force-dynamic";

type Filter = "active" | "unread" | "archived";

/**
 * /notifications — Phase C2 notification center.
 *
 * On load we reconcile REAL operational state (failed/blocked/stale/
 * expiring) into the feed via syncOperationalNotifications (idempotent,
 * best-effort). The list is recipient-scoped by RLS. Each row deep-links
 * to the entity it's about. No notification is invented.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams?: { filter?: string; page?: string };
}) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Notifications" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Supabase is not configured.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Notifications" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard first.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userId = user?.id ?? null;
  if (!userId) {
    return (
      <>
        <Topbar title="Notifications" description="Not signed in." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Sign in to view notifications.
        </div>
      </>
    );
  }

  // Reconcile current operational state into the feed (idempotent).
  await syncOperationalNotifications({ workspaceId, userId }).catch((err) => {
    console.error("[notifications] sync on load failed (non-fatal)", err);
  });

  const filter: Filter =
    searchParams?.filter === "unread"
      ? "unread"
      : searchParams?.filter === "archived"
        ? "archived"
        : "active";
  const statuses: NotificationStatus[] =
    filter === "unread"
      ? ["unread"]
      : filter === "archived"
        ? ["archived"]
        : ["unread", "read"];
  const page = Math.max(1, Number(searchParams?.page ?? 1) || 1);

  const prefs = await getNotificationPreferences(workspaceId, userId);
  const periodHours = prefs.digestCadence === "weekly" ? 24 * 7 : 24;

  const [feed, digestCounts] = await Promise.all([
    listNotificationsPage({ workspaceId, userId, statuses, page, pageSize: 20 }),
    gatherDigestCounts(workspaceId, { periodHours, userId }),
  ]);
  const digestPreview = buildOperationalDigest(digestCounts, {
    workspaceName: membership.workspace.name,
    period: prefs.digestCadence === "weekly" ? "weekly" : "daily",
  });

  return (
    <>
      <Topbar
        title="Notifications"
        description="Operational alerts from your real publishing pipeline."
        actions={<MarkAllReadButton disabled={feed.unread === 0} />}
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {/* Filter tabs */}
        <div className="flex items-center gap-1 text-xs">
          {(
            [
              ["active", "All"],
              ["unread", `Unread${feed.unread ? ` (${feed.unread})` : ""}`],
              ["archived", "Archived"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <Link
              key={key}
              href={`/notifications?filter=${key}`}
              className={`px-3 py-1.5 rounded-md ${
                filter === key
                  ? "bg-ink-100 text-ink-900 font-medium"
                  : "text-ink-500 hover:bg-ink-50 hover:text-ink-800"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        {/* Feed */}
        <section className="card divide-y divide-ink-100">
          {feed.rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-ink-500">
              {filter === "archived"
                ? "No archived notifications."
                : filter === "unread"
                  ? "Nothing unread. You're all caught up."
                  : "No notifications yet. Operational alerts will appear here."}
            </div>
          ) : (
            feed.rows.map((n) => <NotificationItem key={n.id} n={n} />)
          )}
        </section>

        {feed.totalPages > 1 ? (
          <Pagination filter={filter} page={feed.page} totalPages={feed.totalPages} />
        ) : null}

        {/* Preferences */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Delivery preferences</h2>
          <p className="text-xs text-ink-500 mt-1 mb-4">
            Choose how the operational digest reaches you. Preferences are per
            person, per workspace.
          </p>
          <PreferencesForm
            value={{
              emailEnabled: prefs.emailEnabled,
              telegramEnabled: prefs.telegramEnabled,
              digestCadence: prefs.digestCadence,
              connectionWarningDays: prefs.connectionWarningDays,
            }}
          />
        </section>

        {/* Digest preview + manual send */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            {prefs.digestCadence === "weekly" ? "Weekly" : "Daily"} digest preview
          </h2>
          <p className="text-xs text-ink-500 mt-1 mb-3">
            Real pipeline counts — never engagement estimates. Sends to your
            enabled channels.
          </p>
          <DigestControls preview={digestPreview} />
        </section>

        <section className="card p-5 text-[11px] text-ink-500 leading-relaxed">
          <p>
            Notifications mirror real operational state (failed, blocked,
            stalled, or expiring). They never publish on your behalf, never
            bypass approvals, and never contain fabricated engagement metrics.
          </p>
        </section>
      </div>
    </>
  );
}

function entityHref(type: string | null, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case "execution_item":
      return `/execution/items/${id}`;
    case "platform_connection":
      return "/accounts";
    case "workspace_invitation":
    case "workspace":
      return "/settings/team";
    default:
      return null;
  }
}

const TYPE_TONE: Record<NotificationType, string> = {
  publish_failed: "badge-high",
  retry_exhausted: "badge-high",
  publish_blocked: "badge-medium",
  stale_claim: "badge-medium",
  connection_expiring: "badge-medium",
  invitation_received: "badge-info",
  invitation_accepted: "badge-low",
  ownership_transferred: "badge-info",
};

function NotificationItem({ n }: { n: NotificationRecord }) {
  const href = entityHref(n.entityType, n.entityId);
  const title = (
    <span
      className={`text-sm ${n.status === "unread" ? "font-semibold text-ink-900" : "text-ink-700"}`}
    >
      {n.title}
    </span>
  );
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {n.status === "unread" ? (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-600" aria-label="unread" />
          ) : null}
          <span className={`${TYPE_TONE[n.type] ?? "badge-neutral"} text-[10px]`}>
            {n.type.replace(/_/g, " ")}
          </span>
        </div>
        {href ? (
          <Link href={href} className="block hover:underline">
            {title}
          </Link>
        ) : (
          <div>{title}</div>
        )}
        {n.body ? <p className="text-xs text-ink-500">{n.body}</p> : null}
        <p className="text-[10px] text-ink-400">{formatWhen(n.createdAt)}</p>
      </div>
      <NotificationRowActions id={n.id} status={n.status} />
    </div>
  );
}

function Pagination({
  filter,
  page,
  totalPages,
}: {
  filter: Filter;
  page: number;
  totalPages: number;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-ink-500">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link
            href={`/notifications?filter=${filter}&page=${page - 1}`}
            className="btn-ghost text-xs"
          >
            ← Newer
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={`/notifications?filter=${filter}&page=${page + 1}`}
            className="btn-ghost text-xs"
          >
            Older →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
