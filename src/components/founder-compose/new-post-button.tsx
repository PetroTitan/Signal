"use client";

import { useState } from "react";
import {
  FounderComposeSheet,
  type FounderComposeSheetDefaults,
} from "./founder-compose-sheet";

export interface NewPostButtonProps {
  defaults: FounderComposeSheetDefaults;
  /** Visual variant. "inline" sits in the topbar. "fab" floats. */
  variant?: "inline" | "fab";
  /** Optional CSS classes for visibility control (e.g. md:hidden). */
  className?: string;
}

/**
 * Primary "+ New post" control. Renders either an inline button
 * (topbar action on desktop) or a floating action button (sticky
 * bottom-right on mobile). Both invoke the same compose sheet.
 *
 * Render two instances on the page with mutually-exclusive
 * responsive classes — neither needs to know about the other.
 */
export function NewPostButton(props: NewPostButtonProps) {
  const [open, setOpen] = useState(false);

  if (props.variant === "fab") {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          // Sits above the pinned mobile nav rather than on top of it.
          // Previously the FAB occupied 20–64px from the viewport
          // bottom, which covered the right-most nav tab once the
          // document bottom was reached. The FAB is only rendered below
          // md and the nav below lg, so they always coexist — the offset
          // is unconditional.
          style={{
            bottom: "calc(1.25rem + 3.5rem + env(safe-area-inset-bottom))",
          }}
          className={`fixed z-40 right-5 shadow-lg rounded-full px-5 py-3 bg-signal-600 text-white font-semibold text-sm hover:bg-signal-700 active:scale-95 transition ${props.className ?? ""}`}
          aria-label="New post"
        >
          + New post
        </button>
        <FounderComposeSheet
          open={open}
          onClose={() => setOpen(false)}
          defaults={props.defaults}
        />
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`btn-primary text-sm ${props.className ?? ""}`}
      >
        + New post
      </button>
      <FounderComposeSheet
        open={open}
        onClose={() => setOpen(false)}
        defaults={props.defaults}
      />
    </>
  );
}
