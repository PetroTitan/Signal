import Link from "next/link";
import { signOutAction } from "@/app/(auth)/_actions";

/**
 * Calm, controlled error state for post-auth bootstrap failure. The user
 * is authenticated but their workspace could not be created or loaded.
 * Renders an honest explanation, a Try again link, and a Sign out form
 * so the user can recover.
 */
export function BootstrapFailedNotice({
  userEmail,
  message,
}: {
  userEmail: string | null;
  message: string;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-ink-50/40">
      <div className="card max-w-md w-full p-6 space-y-4">
        <div>
          <h1 className="text-base font-semibold text-ink-900">
            We could not load your workspace
          </h1>
          <p className="text-sm text-ink-600 mt-1 leading-relaxed">
            You are signed in
            {userEmail ? (
              <>
                {" "}
                as <span className="font-mono text-xs">{userEmail}</span>
              </>
            ) : null}
            , but the workspace setup did not finish. This is usually
            transient.
          </p>
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50/70 p-3 text-xs text-ink-700">
          <div className="font-medium text-ink-900 mb-1">Detail</div>
          <div className="leading-relaxed break-words">{message}</div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard" className="btn-primary">
            Try again
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="btn">
              Sign out
            </button>
          </form>
        </div>

        <p className="text-[11px] text-ink-500 leading-relaxed">
          If this keeps happening, share the message above with the
          operator. No data is lost.
        </p>
      </div>
    </main>
  );
}
