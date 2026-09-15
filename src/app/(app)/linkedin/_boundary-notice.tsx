import Link from "next/link";

/**
 * The persistent explanation of what Signal does and does not do with
 * LinkedIn. Rendered by the section layout on every page.
 */
export function BoundaryNotice() {
  return (
    <aside
      aria-label="How Signal works with LinkedIn"
      className="card card-padded border-signal-200 bg-signal-50 text-sm text-ink-800 leading-relaxed"
    >
      <p className="font-semibold text-signal-800">Signal prepares tasks. You do the LinkedIn part.</p>
      <p className="mt-1">
        Signal never signs in to LinkedIn, never opens or reads a profile, and never sends a connection request,
        message, like, follow or comment. Each task gives you a draft and a link. You open the profile yourself,
        act yourself, and then mark the task completed yourself. Nothing is completed on your behalf.
      </p>
      <p className="mt-1">
        <Link href="/linkedin/compliance" className="underline font-medium text-signal-800 inline-flex items-center min-h-11">
          What Signal can and cannot do with LinkedIn
        </Link>
      </p>
    </aside>
  );
}
