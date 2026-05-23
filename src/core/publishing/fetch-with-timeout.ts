/**
 * Phase F4.2 — bounded fetch.
 *
 * The native `fetch` has no default timeout; a hung TCP connection
 * to dev.to / Hashnode / Bluesky would block the publish action
 * indefinitely. This helper wires `AbortController` into every
 * outbound publish call so the worst case is a clean failure.
 *
 * Default: 20 seconds. Adapters can pass a custom value.
 */

export interface FetchTimeoutOptions extends RequestInit {
  /** Milliseconds; default 20_000. */
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  init: FetchTimeoutOptions = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { timeoutMs: _omit, signal: _signal, ...rest } = init;
    void _omit;
    void _signal;
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    return (
      err.name === "AbortError" ||
      err.message.toLowerCase().includes("aborted")
    );
  }
  return false;
}
