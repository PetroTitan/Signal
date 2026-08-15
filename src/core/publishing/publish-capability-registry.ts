/**
 * Publish capability registry — the pure declaration site for the
 * two capability sets the execution-integrity invariant is built on.
 *
 * Why this module exists
 * ----------------------
 * Before it, `PLATFORMS_WITH_REAL_PUBLISHER` was declared inside
 * `publishing-runner.ts` and `SCHEDULER_AUTONOMOUS_PLATFORMS` inside
 * `publishing-scheduler.ts`. Both of those modules start with
 * `import "server-only"`, so **no client component could read
 * capability truth**. That is the root cause of the editor's
 * destination drift: the compose sheet could not ask "which
 * platforms can Signal actually publish to?", so it carried its own
 * hardcoded four-entry list instead (`PLATFORM_CHOICES`), which then
 * silently fell behind as X and Telegram gained real publishers.
 *
 * The fix is not "another list". It is moving the SINGLE declaration
 * to a pure module that both the server publishing stack and the
 * client editor can import. `publishing-runner.ts` and
 * `publishing-scheduler.ts` re-export these names unchanged, so every
 * existing import site — including the P0.3 capability-truth
 * invariant test — keeps working and keeps guarding the same thing.
 *
 * Hard rules
 * ----------
 *   - Pure. No I/O, no `server-only`, no React. Safe in a client
 *     bundle (it is two frozen string sets).
 *   - This module DECLARES capability; it never widens it. Adding a
 *     platform here without a real publisher fails
 *     `src/test/platform-capability-truth.test.ts`, which scans the
 *     filesystem for `publishNotImplemented` stubs.
 *   - UI visibility is NOT authorization. A surface may render a
 *     platform that is absent from these sets, but it must never
 *     present it as autonomously schedulable.
 *
 * The invariant these sets participate in:
 *
 *     MCP schedulable ⊆ scheduler autonomous ⊆ real publisher
 */

import type { PublishPlatform } from "./publishing-types";

/**
 * Platforms with a real, non-stub `publishTo<Platform>` implementation.
 *
 * Checked against the filesystem by
 * `src/test/platform-capability-truth.test.ts`: a stub added here, or
 * a publisher implemented without being declared here, fails the
 * suite. Do not edit this set to make a test pass — edit it only when
 * a publisher genuinely lands or is removed.
 */
export const PLATFORMS_WITH_REAL_PUBLISHER: ReadonlySet<PublishPlatform> =
  new Set<PublishPlatform>([
    "bluesky",
    "devto",
    "hashnode",
    "reddit",
    "telegram",
    "x",
  ]);

/**
 * Platforms the scheduler may drive end-to-end without a human.
 *
 * P0.3 removed "linkedin": `publishToLinkedIn` is a stub returning
 * `not_implemented`, which the scheduler maps to a TERMINAL `failed`
 * status — an autonomous claim for LinkedIn could only ever produce a
 * guaranteed failure that pauses the operator's plan item.
 *
 * Manual-distribution platforms (linkedin / youtube / threads /
 * instagram) and no-API platforms (indie_hackers) are deliberately
 * absent. Their execution items fall through to the honest
 * `platform_not_supported` blocked outcome rather than pretending.
 */
export const SCHEDULER_AUTONOMOUS_PLATFORMS: ReadonlySet<PublishPlatform> =
  new Set<PublishPlatform>([
    "reddit",
    "x",
    "bluesky",
    "devto",
    "hashnode",
    "telegram",
  ]);

/**
 * True when the scheduler may publish this platform autonomously.
 *
 * Deliberately the AND of both sets rather than a lookup in either
 * one alone: "the scheduler is allowed to try" and "a real publisher
 * exists" are separate claims, and a UI that gates on only the first
 * would re-open exactly the LinkedIn-shaped hole P0.3 closed.
 *
 * Accepts an arbitrary string so callers holding a `FounderPlatform`
 * (which includes `indie_hackers`, not a `PublishPlatform`) or a raw
 * DB column value can ask without casting.
 */
export function isAutonomouslySchedulable(platform: string): boolean {
  return (
    (SCHEDULER_AUTONOMOUS_PLATFORMS as ReadonlySet<string>).has(platform) &&
    (PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(platform)
  );
}
