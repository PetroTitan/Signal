"use client";

/**
 * Deep-link focus handler.
 *
 * Reads `?focus=<itemId>` from the URL on mount. If present, finds
 * the matching <article id="plan-item-<itemId>"> in the DOM,
 * scrolls it into view, and applies a brief ring highlight that
 * fades after ~2.5 seconds.
 *
 * Rendered once at the top of the weekly-plan page (not per item).
 * No I/O, no DB. Pure client-side behavior bound to the existing
 * server-rendered card anchors.
 */

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

const HIGHLIGHT_CLASSES = ["ring-2", "ring-signal-400", "ring-offset-2"];
const HIGHLIGHT_DURATION_MS = 2500;

export function FocusOnMount() {
  const params = useSearchParams();
  const focusId = params?.get("focus") ?? null;

  useEffect(() => {
    if (!focusId) return;
    // Defer to next tick so the DOM is fully painted before we
    // scroll — the cards may still be hydrating when this effect
    // fires.
    const handle = window.requestAnimationFrame(() => {
      const el = document.getElementById(`plan-item-${focusId}`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add(...HIGHLIGHT_CLASSES);
      window.setTimeout(() => {
        el.classList.remove(...HIGHLIGHT_CLASSES);
      }, HIGHLIGHT_DURATION_MS);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [focusId]);

  return null;
}
