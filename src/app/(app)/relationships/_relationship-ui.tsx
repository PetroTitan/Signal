"use client";
/**
 * Bluesky Relationships — the operator surface.
 *
 * MOBILE-FIRST, and specifically: nothing in here has a fixed pixel
 * width, no table is used for tabular-looking data, and every long
 * string that cannot wrap on its own (a DID, a handle) carries
 * `break-all` or `truncate` with `min-w-0` on its flex parent. Flex
 * children default to `min-width:auto`, so a long DID inside a flex row
 * pushes the row wider than the viewport unless the parent opts out —
 * that is the single most common cause of horizontal overflow on a
 * 320px screen, and this file avoids it deliberately rather than by
 * luck.
 *
 * The tab strip itself scrolls horizontally INSIDE its own container
 * (`overflow-x-auto`), which is the one place sideways movement is
 * correct; the page body never does.
 *
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------
 * No quality score, no ranking, no "recommended to follow", no growth
 * projection, no follow-back rate, no AI anything. A candidate is shown
 * with its identity, its observed relationship state, where it was
 * found, and whether it is protected — facts, all of them, and nothing
 * that implies Signal has an opinion about who is worth following.
 */

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import {
  addTargetAction,
  followSelectedAction,
  importFollowersAction,
  refreshRelationshipsAction,
  continueBatchAction,
  removeTargetAction,
  setProtectedAction,
  unfollowSelectedAction,
  type AddTargetActionResult,
  type ImportActionResult,
  type ProtectActionResult,
  type RefreshActionResult,
  type ContinueBatchResult,
  type RelationshipBatchResult,
  type RemoveTargetActionResult,
} from "./_actions";
import { relationshipLabel } from "@/core/bluesky-relationships/relationship-state";
import {
  bareHandle,
  formatAccountName,
  formatHandle,
  formatIdentityLabel,
} from "@/core/bluesky-relationships/handle-display";
import {
  canSelectMore,
  MAX_RELATIONSHIP_BATCH_SIZE,
  remainingSelectionCapacity,
} from "@/core/bluesky-relationships/limits";
import {
  ConfirmActionDialog,
  type ConfirmKind,
  type ConfirmRequest,
  type ConfirmResult,
} from "./_confirm-dialog";
import { Pager, SearchAndFilter, TabStrip } from "./_nav-controls";
import type {
  PageInfo,
  RelationshipsQuery,
  RelationshipTab,
} from "@/core/bluesky-relationships/load-relationships.server.types";
import type { BlueskyActionBatchRow } from "@/lib/supabase/types";
import type {
  BlueskyRelationshipActionRow,
  BlueskyRelationshipState,
} from "@/lib/supabase/types";
import type { CandidateWithSources } from "@/repositories/bluesky-relationship-repository";
import type { TargetWithImport } from "@/core/bluesky-relationships/load-relationships.server";

export interface RelationshipUiProps {
  identities: { id: string; handle: string | null; displayName: string | null }[];
  selectedIdentityId: string | null;
  connected: boolean;
  query: RelationshipsQuery;
  targets: TargetWithImport[];
  candidates: CandidateWithSources[];
  candidatePage: PageInfo;
  history: BlueskyRelationshipActionRow[];
  historyPage: PageInfo;
  batches: BlueskyActionBatchRow[];
  counts: {
    total: number;
    unknown: number;
    not_following: number;
    following: number;
    follows_you: number;
    mutual: number;
    protectedCount: number;
    needsReconciliation: number;
  };
  automation: {
    hasCampaign: boolean;
    canManage: boolean;
    href: string;
  };
  targetLabels: Record<string, string>;
}

const EMPTY_ADD: AddTargetActionResult = { ok: false, error: "" };
const EMPTY_IMPORT: ImportActionResult = { ok: false, error: "" };
const EMPTY_REFRESH: RefreshActionResult = { ok: false, error: "" };
const EMPTY_BATCH: RelationshipBatchResult = { ok: false, error: "" };
const EMPTY_PROTECT: ProtectActionResult = { ok: false, error: "" };
const EMPTY_REMOVE: RemoveTargetActionResult = { ok: false, error: "" };
const EMPTY_CONTINUE: ContinueBatchResult = { ok: false, error: "" };

function stateBadgeClass(state: BlueskyRelationshipState): string {
  switch (state) {
    case "mutual":
      return "badge-low";
    case "following":
      return "badge-info";
    case "follows_you":
      return "badge-neutral";
    case "not_following":
      return "badge-neutral";
    case "unknown":
      // Amber, not grey: unknown is a state the operator should notice,
      // because it is exactly the state a batch action must not assume
      // away.
      return "badge-medium";
  }
}

function SubmitButton({
  children,
  className = "btn-secondary",
  disabled,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled}>
      {pending ? "Working…" : children}
    </button>
  );
}

function Notice({ result }: { result: { ok: boolean; error: string | null } & Record<string, unknown> }) {
  if (result.ok && typeof result.summary === "string") {
    return (
      <p className="text-sm text-emerald-700 mt-2 leading-relaxed">
        {result.summary}
      </p>
    );
  }
  if (!result.ok && result.error) {
    return (
      <p className="text-sm text-red-700 mt-2 leading-relaxed">{result.error}</p>
    );
  }
  return null;
}

export function RelationshipUi(props: RelationshipUiProps) {
  const tab: RelationshipTab = props.query.tab;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The imported list is primarily the source for an automatic
  // campaign. Manual mutation tools remain available for exceptions,
  // but do not dominate the default 10,000+ profile workflow.
  const [manualCandidateMode, setManualCandidateMode] = useState(false);
  const identityId = props.selectedIdentityId ?? "";

  const [addState, addTarget] = useFormState(addTargetAction, EMPTY_ADD);
  const [importState, runImport] = useFormState(importFollowersAction, EMPTY_IMPORT);
  const [refreshState, runRefresh] = useFormState(
    refreshRelationshipsAction,
    EMPTY_REFRESH,
  );
  const [followState, runFollow] = useFormState(followSelectedAction, EMPTY_BATCH);
  const [unfollowState, runUnfollow] = useFormState(
    unfollowSelectedAction,
    EMPTY_BATCH,
  );
  const [protectState, runProtect] = useFormState(
    setProtectedAction,
    EMPTY_PROTECT,
  );
  const [removeState, runRemove] = useFormState(
    removeTargetAction,
    EMPTY_REMOVE,
  );
  const [continueState, runContinue] = useFormState(
    continueBatchAction,
    EMPTY_CONTINUE,
  );

  /**
   * The pending confirmation, or null.
   *
   * Every irreversible action routes through this one piece of state.
   * A trigger sets it; Cancel clears it. Because the only
   * `<form action={dispatch}>` for these actions lives inside the
   * dialog, clearing this state removes the only thing that could
   * submit — Cancel cannot reach the server even by accident.
   */
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const dispatchFor = (kind: ConfirmKind) =>
    kind === "follow" ? runFollow : kind === "unfollow" ? runUnfollow : runRemove;

  /**
   * The terminal outcome for whatever is being confirmed.
   *
   * Derived from the matching action's form state rather than held
   * separately, so it cannot get out of step with what actually
   * happened. Once this is non-null the dialog stops being a prompt and
   * becomes a result — the submit control is removed from the tree, so
   * the same batch cannot be submitted twice.
   */
  const confirmResult: ConfirmResult | null = (() => {
    if (!confirming) return null;
    const state =
      confirming.kind === "follow"
        ? followState
        : confirming.kind === "unfollow"
          ? unfollowState
          : removeState;
    if (state.ok) {
      const summary =
        "summary" in state && typeof state.summary === "string"
          ? state.summary
          : "Done.";
      return { ok: true, message: summary };
    }
    // An empty error is the initial state, not a failure.
    return state.error ? { ok: false, message: state.error } : null;
  })();

  // The server already filtered and paged. Filtering again here would
  // re-introduce exactly the defect this replaces: a client deciding
  // what a total means from the one page it happens to hold.
  const visible = props.candidates;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Refuse silently rather than accepting a selection the server
      // will reject. The row's checkbox is disabled at the cap, so this
      // is the belt to that braces.
      if (!canSelectMore(next.size)) return prev;
      next.add(id);
      return next;
    });
  };

  const selectedIds = [...selected].filter((id) =>
    visible.some((c) => c.id === id),
  );
  // Protected accounts are counted here so the operator can see the
  // exclusion BEFORE submitting, not only in the result summary.
  const selectedProtected = visible.filter(
    (c) => selected.has(c.id) && c.protected,
  ).length;

  const toggleManualCandidateMode = () => {
    if (manualCandidateMode) setSelected(new Set());
    setManualCandidateMode(!manualCandidateMode);
  };

  const tabs: { key: RelationshipTab; label: string; count: number | null }[] = [
    { key: "targets", label: "Targets", count: props.targets.length },
    { key: "candidates", label: "Imported list", count: props.counts.total },
    {
      key: "following",
      label: "Following",
      count: props.counts.following + props.counts.mutual,
    },
    { key: "mutual", label: "Mutual", count: props.counts.mutual },
    { key: "batches", label: "Batches", count: props.batches.length },
    { key: "history", label: "History", count: props.historyPage.total },
  ];

  if (props.identities.length === 0) {
    return (
      <div className="card card-padded">
        <h2 className="section-title">No Bluesky identity</h2>
        <p className="text-sm text-ink-600 mt-2 leading-relaxed">
          Relationship actions run as one of your Bluesky publishing
          identities. Add one on the Accounts page and sign it in first.
        </p>
        <a href="/accounts" className="btn-nav mt-4 inline-flex">
          Go to Accounts
        </a>
      </div>
    );
  }

  const actorLabel = formatIdentityLabel(
    props.identities.find((i) => i.id === identityId) ?? {
      id: identityId,
      handle: null,
      displayName: null,
    },
  );

  return (
    <div className="space-y-4">
      <ConfirmActionDialog
        request={confirming}
        dispatch={confirming ? dispatchFor(confirming.kind) : () => undefined}
        onCancel={() => setConfirming(null)}
        result={confirmResult}
      />

      {/* Identity picker + connection state. */}
      <section className="card card-padded">
        <h2 className="section-title">Acting as</h2>
        <form method="get" className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="identity" className="sr-only">
            Bluesky identity
          </label>
          <select
            id="identity"
            name="identity"
            defaultValue={identityId}
            className="input min-w-0 flex-1"
          >
            {props.identities.map((i) => (
              <option key={i.id} value={i.id}>
                {formatIdentityLabel(i)}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-secondary">
            Switch
          </button>
        </form>
        {!props.connected ? (
          <p className="text-sm text-amber-700 mt-3 leading-relaxed">
            This identity is not signed in to Bluesky. You can browse what has
            already been imported, but following and unfollowing need a signed-in
            session. Connect it from the identity&apos;s Manage panel on Accounts.
          </p>
        ) : null}
      </section>

      {/* Tabs are links: the whole view is a function of the URL, so a
          filtered page is shareable and Back works. */}
      <TabStrip tabs={tabs} active={tab} />

      {props.counts.needsReconciliation > 0 ? (
        <div className="card card-padded border-amber-200 bg-amber-50">
          <p className="text-sm text-amber-900 leading-relaxed">
            <strong>{props.counts.needsReconciliation}</strong> action(s) need
            reconciliation. Bluesky did not confirm the outcome, so Signal read
            the relationship and stopped rather than sending the request again.
            Open History to see what each one observed.
          </p>
        </div>
      ) : null}

      {tab === "targets" ? (
        <TargetsView
          identityId={identityId}
          targets={props.targets}
          addTarget={addTarget}
          addState={addState}
          runImport={runImport}
          importState={importState}
          removeState={removeState}
          actorLabel={actorLabel}
          onConfirm={setConfirming}
        />
      ) : null}

      {tab === "history" ? (
        <HistoryView
          history={props.history}
          historyPage={props.historyPage}
          targetLabels={props.targetLabels}
        />
      ) : null}

      {tab === "batches" ? (
        <BatchesView
          identityId={identityId}
          batches={props.batches}
          connected={props.connected}
          runContinue={runContinue}
          continueState={continueState}
        />
      ) : null}

      {tab !== "targets" && tab !== "history" && tab !== "batches" ? (
        <CandidateListView
          identityId={identityId}
          candidates={visible}
          targetLabels={props.targetLabels}
          selected={selected}
          selectedIds={selectedIds}
          selectedProtected={selectedProtected}
          onToggle={toggle}
          onSelectNone={() => setSelected(new Set())}
          onSelectAll={() =>
            setSelected((prev) => {
              // "Visible" means the rows on screen — never the whole
              // table. Fills up to the cap and stops; it does not
              // silently select more than can be submitted.
              const next = new Set(prev);
              for (const c of visible) {
                if (remainingSelectionCapacity(next.size) === 0) break;
                next.add(c.id);
              }
              return next;
            })
          }
          followState={followState}
          unfollowState={unfollowState}
          runRefresh={runRefresh}
          refreshState={refreshState}
          connected={props.connected}
          showFollowAction={tab === "candidates"}
          runProtect={runProtect}
          protectState={protectState}
          actorLabel={actorLabel}
          onConfirm={setConfirming}
          page={props.candidatePage}
          query={props.query}
          counts={props.counts}
          automation={props.automation}
          manualCandidateMode={manualCandidateMode}
          onToggleManualCandidateMode={toggleManualCandidateMode}
        />
      ) : null}
    </div>
  );
}

// =====================================================================
// Targets
// =====================================================================

function TargetsView(props: {
  identityId: string;
  targets: TargetWithImport[];
  addTarget: (formData: FormData) => void;
  addState: AddTargetActionResult;
  runImport: (formData: FormData) => void;
  importState: ImportActionResult;
  removeState: RemoveTargetActionResult;
  actorLabel: string;
  onConfirm: (request: ConfirmRequest) => void;
}) {
  return (
    <div className="space-y-4">
      <section className="card card-padded">
        <h2 className="section-title">Add a target profile</h2>
        <p className="text-sm text-ink-600 mt-2 leading-relaxed">
          Signal imports this profile&apos;s followers into one deduplicated list
          you can act on. The handle is resolved to its permanent account ID, so a
          later rename does not lose the target or its history.
        </p>
        <form action={props.addTarget} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="operator_account_id" value={props.identityId} />
          <label htmlFor="identifier" className="sr-only">
            Bluesky handle
          </label>
          <input
            id="identifier"
            name="identifier"
            placeholder="handle.bsky.social"
            className="input flex-1 min-w-0"
            autoComplete="off"
          />
          <SubmitButton className="btn-primary">Add target</SubmitButton>
        </form>
        <Notice result={props.addState} />
      </section>

      <Notice result={props.importState} />
      <Notice result={props.removeState} />

      {props.targets.length === 0 ? (
        <div className="card card-padded">
          <p className="text-sm text-ink-600 leading-relaxed">
            No target profiles yet. Add a Bluesky handle above to import its
            followers.
          </p>
        </div>
      ) : null}

      <ul className="list-none p-0 m-0 space-y-3">
        {props.targets.map(({ target, run, progressLabel, complete }) => (
          <li key={target.id} className="card card-padded">
            <div className="flex items-start gap-3 min-w-0">
              {target.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={target.avatar_url}
                  alt=""
                  className="w-10 h-10 rounded-full shrink-0 bg-ink-100"
                />
              ) : (
                <div className="w-10 h-10 rounded-full shrink-0 bg-ink-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink-900 break-words">
                  {formatAccountName({
                    displayName: target.display_name,
                    handle: target.handle,
                  })}
                </p>
                <p className="text-sm text-ink-600 break-all">
                  {formatHandle(target.handle)}
                </p>
                <p className="text-xs text-ink-500 break-all mt-0.5">
                  {target.subject_did}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className={complete ? "badge-low" : "badge-neutral"}>
                {progressLabel}
              </span>
              {target.followers_count !== null ? (
                <span className="text-xs text-ink-500">
                  {target.followers_count.toLocaleString()} followers on Bluesky
                </span>
              ) : null}
            </div>
            {run?.last_error ? (
              <p className="text-xs text-amber-700 mt-2 leading-relaxed break-words">
                {run.last_error}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {/* A completed import offers no "import" CTA: there is
                  nothing left to fetch, and a primary button reading
                  "Imported" invites a click that does nothing. The
                  status badge above already says it is complete, and
                  Re-import is the real action. */}
              {complete ? null : (
                <form action={props.runImport}>
                  <input
                    type="hidden"
                    name="operator_account_id"
                    value={props.identityId}
                  />
                  <input type="hidden" name="target_profile_id" value={target.id} />
                  <SubmitButton className="btn-primary">
                    {run === null
                      ? "Import up to 10,000 followers"
                      : "Import next 10,000"}
                  </SubmitButton>
                </form>
              )}
              {complete ? (
                <form action={props.runImport}>
                  <input
                    type="hidden"
                    name="operator_account_id"
                    value={props.identityId}
                  />
                  <input type="hidden" name="target_profile_id" value={target.id} />
                  <input type="hidden" name="restart" value="1" />
                  <SubmitButton>Re-import up to 10,000</SubmitButton>
                </form>
              ) : null}
              <button
                type="button"
                className="btn-danger"
                onClick={() =>
                  props.onConfirm({
                    kind: "remove_target",
                    actorLabel: props.actorLabel,
                    fields: [
                      { name: "operator_account_id", value: props.identityId },
                      { name: "target_profile_id", value: target.id },
                    ],
                    itemLabels: [formatHandle(target.handle, target.subject_did)],
                    protectedExcluded: 0,
                  })
                }
              >
                Remove…
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =====================================================================
// Candidates / Following / Mutual
// =====================================================================

function CandidateListView(props: {
  identityId: string;
  candidates: CandidateWithSources[];
  targetLabels: Record<string, string>;
  selected: Set<string>;
  selectedIds: string[];
  selectedProtected: number;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  followState: RelationshipBatchResult;
  unfollowState: RelationshipBatchResult;
  runRefresh: (formData: FormData) => void;
  refreshState: RefreshActionResult;
  connected: boolean;
  showFollowAction: boolean;
  runProtect: (formData: FormData) => void;
  protectState: ProtectActionResult;
  actorLabel: string;
  onConfirm: (request: ConfirmRequest) => void;
  page: PageInfo;
  query: RelationshipsQuery;
  counts: {
    total: number;
    unknown: number;
    not_following: number;
    following: number;
    follows_you: number;
    mutual: number;
  };
  automation: RelationshipUiProps["automation"];
  manualCandidateMode: boolean;
  onToggleManualCandidateMode: () => void;
}) {
  const anySelected = props.selectedIds.length > 0;
  const atCap = props.selectedIds.length >= MAX_RELATIONSHIP_BATCH_SIZE;
  const isImportedList = props.query.tab === "candidates";
  const showManualControls = !isImportedList || props.manualCandidateMode;

  const label = (id: string): string => {
    const c = props.candidates.find((x) => x.id === id);
    return c ? formatHandle(c.handle, c.subject_did) : id;
  };

  /**
   * Build the confirmation request for a set of candidate ids.
   *
   * Protected accounts are removed here so the dialog can state the
   * exclusion honestly BEFORE the operator confirms, rather than
   * reporting it afterwards in a result summary. The server filters
   * them again independently — this is presentation, not enforcement.
   */
  const request = (kind: "follow" | "unfollow", ids: string[]): ConfirmRequest => {
    const eligible =
      kind === "unfollow"
        ? ids.filter((id) => !props.candidates.find((c) => c.id === id)?.protected)
        : ids;
    return {
      kind,
      actorLabel: props.actorLabel,
      fields: [
        { name: "operator_account_id", value: props.identityId },
        ...eligible.map((id) => ({ name: "candidate_id", value: id })),
      ],
      itemLabels: eligible.map(label),
      protectedExcluded: ids.length - eligible.length,
    };
  };

  return (
    <div className="space-y-4">
      {isImportedList ? (
        <section className="card card-padded" data-testid="imported-list-workflow">
          <h2 className="section-title">Your imported list</h2>
          <p className="mt-2 text-sm text-ink-700 leading-relaxed">
            <strong>{props.counts.total.toLocaleString()}</strong> profiles are
            available. An automatic campaign can work through this whole list on
            your daily schedule — you do not need to select people in groups of 20.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {props.automation.hasCampaign || props.automation.canManage ? (
              <a href={props.automation.href} className="btn-primary">
                {props.automation.hasCampaign
                  ? "Open automatic campaign"
                  : "Start automatic campaign"}
              </a>
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              aria-expanded={props.manualCandidateMode}
              aria-controls="manual-relationship-tools"
              onClick={props.onToggleManualCandidateMode}
            >
              {props.manualCandidateMode
                ? "Hide manual tools"
                : "Use manual tools"}
            </button>
          </div>
          {!props.automation.hasCampaign && !props.automation.canManage ? (
            <p className="mt-3 text-sm text-ink-500 leading-relaxed">
              Ask a workspace owner or admin to start automatic following.
            </p>
          ) : null}
          {props.manualCandidateMode ? (
            <p className="mt-3 text-sm text-ink-500 leading-relaxed">
              Manual tools act immediately and are limited to 20 profiles per
              confirmed batch. Use them only for one-off corrections or checks.
            </p>
          ) : null}
        </section>
      ) : null}

      <SearchAndFilter
        search={props.query.search}
        state={props.query.state}
        // State chips belong on the unfiltered Imported list tab. On
        // Following and Mutual the tab already IS the filter, and a
        // second one would let the operator build a contradiction.
        showStateFilter={props.query.tab === "candidates"}
        counts={props.counts}
        total={props.counts.total}
      />

      {showManualControls ? (
        <section
          id="manual-relationship-tools"
          className="card card-padded"
          data-testid="manual-relationship-tools"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={props.onSelectAll}
              disabled={atCap || props.candidates.length === 0}
            >
              {/* Named for what it does. "Select all" implied the whole
                  database; this list is one page of it. */}
              Select visible ({props.candidates.length})
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={props.onSelectNone}
            >
              Clear
            </button>
            <span className="text-sm text-ink-600">
              {props.selectedIds.length} of {MAX_RELATIONSHIP_BATCH_SIZE}{" "}
              selected
            </span>
          </div>

          {atCap ? (
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              That is the most a single batch can hold. A batch runs while you
              wait, so it is bounded to finish inside one request. Run this one,
              then select the next {MAX_RELATIONSHIP_BATCH_SIZE}.
            </p>
          ) : null}

          {props.selectedProtected > 0 ? (
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              {props.selectedProtected} of these are protected and will be
              excluded from Unfollow.
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {/* These are plain buttons, not submits. They open the
                confirmation; the form that actually dispatches lives
                inside the dialog and nowhere else. */}
            {props.showFollowAction ? (
              <button
                type="button"
                className="btn-primary"
                disabled={!anySelected || !props.connected}
                onClick={() =>
                  props.onConfirm(request("follow", props.selectedIds))
                }
              >
                Follow selected…
              </button>
            ) : null}

            <button
              type="button"
              className="btn-danger"
              disabled={
                !anySelected ||
                !props.connected ||
                props.selectedIds.length === props.selectedProtected
              }
              onClick={() =>
                props.onConfirm(request("unfollow", props.selectedIds))
              }
            >
              Unfollow selected…
            </button>

            <form action={props.runRefresh}>
              <input
                type="hidden"
                name="operator_account_id"
                value={props.identityId}
              />
              {props.selectedIds.map((id) => (
                <input key={id} type="hidden" name="candidate_id" value={id} />
              ))}
              <SubmitButton disabled={!anySelected || !props.connected}>
                Check relationship
              </SubmitButton>
            </form>
          </div>

          <Notice result={props.followState} />
          <Notice result={props.unfollowState} />
          <Notice result={props.refreshState} />
          <Notice result={props.protectState} />
        </section>
      ) : null}

      <Pager info={props.page} param="page" label="Imported profiles" />

      {props.candidates.length === 0 ? (
        <div className="card card-padded">
          <p className="text-sm text-ink-600 leading-relaxed">
            {props.query.search || props.query.state
              ? "No accounts match this search or filter. Clear them to see the full list."
              : "Nothing here yet. Import a target profile\u2019s followers to build your list."}
          </p>
        </div>
      ) : null}

      <ul className="list-none p-0 m-0 space-y-2">
        {props.candidates.map((candidate) => (
          <li key={candidate.id} className="card p-3 sm:p-4">
            <div className="flex items-start gap-3 min-w-0">
              {showManualControls ? (
                <input
                  type="checkbox"
                  checked={props.selected.has(candidate.id)}
                  onChange={() => props.onToggle(candidate.id)}
                  // At the cap, already-checked rows stay interactive so
                  // the operator can swap one out; unchecked ones go
                  // inert rather than accepting a click that does nothing.
                  disabled={atCap && !props.selected.has(candidate.id)}
                  aria-label={`Select ${bareHandle(candidate.handle) ?? candidate.subject_did}`}
                  className="mt-1 shrink-0 w-5 h-5 disabled:opacity-40"
                />
              ) : null}
              {candidate.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={candidate.avatar_url}
                  alt=""
                  className="w-10 h-10 rounded-full shrink-0 bg-ink-100"
                />
              ) : (
                <div className="w-10 h-10 rounded-full shrink-0 bg-ink-100" />
              )}

              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink-900 break-words">
                  {formatAccountName({
                    displayName: candidate.display_name,
                    handle: candidate.handle,
                  })}
                </p>
                <p className="text-sm text-ink-600 break-all">
                  {formatHandle(candidate.handle)}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className={stateBadgeClass(candidate.relationship_state)}>
                    {relationshipLabel(candidate.relationship_state)}
                  </span>
                  {candidate.protected ? (
                    <span className="badge-info">Protected</span>
                  ) : null}
                  {candidate.sourceTargetProfileIds.map((id) => (
                    <span key={id} className="badge-neutral break-all">
                      from {formatHandle(props.targetLabels[id], "unknown source")}
                    </span>
                  ))}
                </div>

                {candidate.relationship_error ? (
                  <p className="text-xs text-amber-700 mt-2 leading-relaxed break-words">
                    {candidate.relationship_error}
                  </p>
                ) : null}

                {showManualControls ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                  {/* A single-account action takes the SAME confirmation
                      path as a batch. One row is still a public,
                      irreversible change to someone else's feed. */}
                  <button
                    type="button"
                    className="btn"
                    disabled={!props.connected}
                    onClick={() => props.onConfirm(request("follow", [candidate.id]))}
                  >
                    Follow…
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    disabled={!props.connected || candidate.protected}
                    onClick={() => props.onConfirm(request("unfollow", [candidate.id]))}
                  >
                    Unfollow…
                  </button>
                  <form action={props.runProtect}>
                    <input
                      type="hidden"
                      name="operator_account_id"
                      value={props.identityId}
                    />
                    <input type="hidden" name="candidate_id" value={candidate.id} />
                    <input
                      type="hidden"
                      name="protected"
                      value={candidate.protected ? "0" : "1"}
                    />
                    <SubmitButton>
                      {candidate.protected ? "Unprotect" : "Protect"}
                    </SubmitButton>
                  </form>
                  </div>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Pager info={props.page} param="page" label="Imported profiles" />
    </div>
  );
}

// =====================================================================
// History
// =====================================================================

function HistoryView(props: {
  history: BlueskyRelationshipActionRow[];
  historyPage: PageInfo;
  targetLabels: Record<string, string>;
}) {
  if (props.history.length === 0) {
    return (
      <div className="card card-padded">
        <p className="text-sm text-ink-600 leading-relaxed">
          No relationship actions yet. Every follow and unfollow is recorded here
          permanently — a later unfollow adds a record, it does not remove the
          follow that preceded it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Pager info={props.historyPage} param="hpage" label="History" />
      <ul className="list-none p-0 m-0 space-y-2">
      {props.history.map((action) => (
        <li key={action.id} className="card p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                action.action_type === "follow" ? "badge-info" : "badge-neutral"
              }
            >
              {action.action_type === "follow" ? "Follow" : "Unfollow"}
            </span>
            <span
              className={
                action.status === "succeeded"
                  ? "badge-low"
                  : action.status === "failed"
                    ? "badge-high"
                    : action.status === "reconciliation_required"
                      ? "badge-medium"
                      : "badge-neutral"
              }
            >
              {action.status.replace(/_/g, " ")}
            </span>
            <span className="text-xs text-ink-500">
              {new Date(action.requested_at).toLocaleString()}
            </span>
          </div>

          <p className="text-sm text-ink-800 mt-2 break-all">
            {/* The handle AS IT WAS when the operator acted. A later
                rename must not rewrite the record. */}
            {formatHandle(action.subject_handle_at_action)}
          </p>
          <p className="text-xs text-ink-500 break-all">{action.subject_did}</p>
          {action.actor_handle_at_action ? (
            <p className="text-xs text-ink-500 break-all mt-0.5">
              as {formatHandle(action.actor_handle_at_action)}
            </p>
          ) : null}

          {action.source_target_profile_ids.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {action.source_target_profile_ids.map((id) => (
                <span key={id} className="badge-neutral break-all">
                  from {formatHandle(props.targetLabels[id], "unknown source")}
                </span>
              ))}
            </div>
          ) : null}

          {action.reconciliation_note ? (
            <p className="text-xs text-amber-800 mt-2 leading-relaxed break-words">
              {action.reconciliation_note}
            </p>
          ) : null}
          {action.provider_error_message && !action.reconciliation_note ? (
            <p className="text-xs text-red-700 mt-2 leading-relaxed break-words">
              {action.provider_error_message}
            </p>
          ) : null}
          {action.batch_id ? (
            <p className="text-xs text-ink-400 mt-2 break-all">
              batch {action.batch_id}
            </p>
          ) : null}
        </li>
      ))}
      </ul>
      <Pager info={props.historyPage} param="hpage" label="History" />
    </div>
  );
}

// =====================================================================
// Batches
// =====================================================================

const BATCH_BADGE: Record<string, string> = {
  completed: "badge-low",
  running: "badge-info",
  paused: "badge-medium",
  failed: "badge-high",
  confirmed: "badge-neutral",
  pending: "badge-neutral",
};

/**
 * Recent batches and their progress.
 *
 * The loader always read these; nothing rendered them, so a batch that
 * stopped halfway was invisible — the operator saw a summary once and
 * had no way back to it. Paused batches are the reason this view
 * exists.
 *
 * Continue is a submit, not a confirmation dialog: it does not choose
 * new targets or widen anything. It resumes work the operator already
 * reviewed and approved, on the frozen membership, and the server
 * re-authorizes everything before sending a single request.
 */
function BatchesView(props: {
  identityId: string;
  batches: BlueskyActionBatchRow[];
  connected: boolean;
  runContinue: (formData: FormData) => void;
  continueState: ContinueBatchResult;
}) {
  if (props.batches.length === 0) {
    return (
      <div className="card card-padded">
        <p className="text-sm text-ink-600 leading-relaxed">
          No batches yet. Selecting accounts and confirming a Follow or Unfollow
          creates one, and it appears here with its progress.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Notice result={props.continueState} />

      <ul className="list-none p-0 m-0 space-y-2">
        {props.batches.map((batch) => {
          const attempted = batch.processed_count;
          const remaining = Math.max(0, batch.requested_count - attempted);
          const resumable = batch.status === "paused" && remaining > 0;

          return (
            <li key={batch.id} className="card p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    batch.action_type === "follow" ? "badge-info" : "badge-neutral"
                  }
                >
                  {batch.action_type === "follow" ? "Follow" : "Unfollow"}
                </span>
                <span className={BATCH_BADGE[batch.status] ?? "badge-neutral"}>
                  {batch.status}
                </span>
                <span className="text-xs text-ink-500">
                  {new Date(batch.created_at).toLocaleString()}
                </span>
              </div>

              <p className="text-sm text-ink-800 mt-2">
                {attempted} of {batch.requested_count} attempted
                {batch.succeeded_count > 0
                  ? ` \u00b7 ${batch.succeeded_count} succeeded`
                  : ""}
                {batch.failed_count > 0 ? ` \u00b7 ${batch.failed_count} failed` : ""}
                {batch.reconciliation_required_count > 0
                  ? ` \u00b7 ${batch.reconciliation_required_count} need reconciliation`
                  : ""}
              </p>

              {remaining > 0 ? (
                <p className="text-sm text-ink-600 mt-1 leading-relaxed">
                  {remaining} not attempted. Membership is fixed at the{" "}
                  {batch.requested_count} accounts you confirmed — continuing
                  never adds newly imported ones.
                </p>
              ) : null}

              {batch.last_error ? (
                <p className="text-xs text-amber-700 mt-2 leading-relaxed break-words">
                  {batch.last_error}
                </p>
              ) : null}

              {resumable ? (
                <form action={props.runContinue} className="mt-3">
                  <input
                    type="hidden"
                    name="operator_account_id"
                    value={props.identityId}
                  />
                  <input type="hidden" name="batch_id" value={batch.id} />
                  <SubmitButton
                    className="btn-primary"
                    disabled={!props.connected}
                  >
                    Continue ({remaining})
                  </SubmitButton>
                </form>
              ) : null}

              {batch.status === "paused" && !props.connected ? (
                <p className="text-sm text-amber-700 mt-2 leading-relaxed">
                  This identity is not signed in to Bluesky, so the batch cannot
                  continue. Reconnect it on Accounts first.
                </p>
              ) : null}

              <p className="text-xs text-ink-400 mt-2 break-all">
                batch {batch.id}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
