"use client";

import { useState } from "react";
import {
  AccountIdentityCard,
  type AccountIdentityCardProps,
} from "@/components/publishing/account-identity-card";
import {
  shouldShowManageButton,
  type ConnectIdentityPlan,
} from "@/core/publishing/connect-identity";

/**
 * Wraps AccountIdentityCard with a per-identity "Manage" toggle.
 *
 * IMPORTANT: each instance of this wrapper owns its own local
 * `manageOpen` state, so opening the Manage panel on identity A
 * never touches identity B — including when both identities are
 * on the same platform (e.g. two Bluesky accounts on one
 * workspace).
 *
 * The wrapper does NOT lift state to a shared context, persist
 * open-state across renders, or call any backend on mount. The
 * toggle is purely visual; account-access actions live in the
 * controls panel and are explicit-click only.
 *
 * Cards whose plan has nothing to manage (unsupported, or
 * undefined) get no Manage button — the page renders them with
 * `manageButton={null}` and an empty controls section.
 */
interface IdentityCardWithManageProps
  extends Omit<AccountIdentityCardProps, "controls" | "manageButton"> {
  /**
   * Resolved Connect plan for this identity. Drives whether the
   * Manage button is shown and what label it carries.
   */
  connectPlan: ConnectIdentityPlan | undefined;
  /**
   * The controls panel that renders when Manage is open. Passed in
   * by the page so the wrapper stays display-only.
   */
  controlsWhenOpen: React.ReactNode;
  /**
   * Optional steady-state copy for cards where Manage isn't useful
   * (manual / distribution platforms). Rendered in place of the
   * controls section even when Manage is closed.
   */
  steadyStateHint?: React.ReactNode;
}

export function IdentityCardWithManage(props: IdentityCardWithManageProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const {
    connectPlan,
    controlsWhenOpen,
    steadyStateHint,
    ...cardProps
  } = props;

  const manageButton = shouldShowManageButton(connectPlan) ? (
    <button
      type="button"
      onClick={() => setManageOpen((v) => !v)}
      aria-expanded={manageOpen}
      aria-label={manageOpen ? "Close Manage panel" : "Open Manage panel"}
      className="text-[10px] text-signal-700 hover:text-signal-800 border border-signal-200 hover:border-signal-300 bg-signal-50 hover:bg-signal-100 rounded px-2 py-0.5 shrink-0"
    >
      {manageOpen ? "Close" : "Manage"}
    </button>
  ) : null;

  // The controls panel renders only when Manage is open. The steady-
  // state hint (used by manual platforms when collapsed) renders
  // when Manage is closed. This keeps the card visually quiet by
  // default and the Manage panel scoped to one identity at a time.
  const controls = (
    <>
      {manageOpen ? controlsWhenOpen : steadyStateHint ?? null}
    </>
  );

  return (
    <AccountIdentityCard
      {...cardProps}
      manageButton={manageButton}
      controls={controls}
    />
  );
}
