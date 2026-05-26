import "server-only";
/**
 * Phase F4.4 — publishing-identity context.
 *
 * Builds the canonical context object that future AI / MCP
 * generation will read when drafting a post for a given identity.
 * No AI calls happen here — this module is preparation only. Its
 * job is to centralize "everything we know about how this identity
 * publishes" so generation code never has to assemble it ad-hoc.
 *
 * The shape is intentionally narrow:
 *   - platform              (where the post goes)
 *   - displayName           (who's posting)
 *   - voiceProfile          (how they write — operator's words)
 *   - associatedProduct     (what product / positioning)
 *   - publishingHistory     (last N successful publishes for context)
 *   - platformGuidance      (editorial hints for the platform)
 *
 * Anything beyond this should be derived in the generation step,
 * not added here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getAccountById } from "@/repositories/account-repository";
import { getProductById } from "@/repositories/product-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import {
  friendlyPlatformLabel,
  resolveIdentityPlatformGuidance,
  type FounderPlatformGuidance,
} from "./platform-guidance";

export type IdentityLifecycleStatus =
  | "planned"
  | "warming"
  | "active"
  | "paused"
  | "setup_needed"
  | "awaiting_manual_creation"
  | "archived";

export interface PublishingIdentityContext {
  identityId: string;
  platform: string;
  platformLabel: string;
  displayName: string | null;
  handle: string | null;
  /** Operator-written voice profile. Verbatim. */
  voiceProfile: string | null;
  /**
   * Phase F7.0 — canonical factual source for this publishing
   * identity. Generation flows ground topic + positioning choices
   * here so they avoid drifting into internal infrastructure
   * conversations. Null only on legacy rows that pre-date the
   * identity-source migration.
   */
  sourceWebsiteUrl: string | null;
  /** Phase F7.0 — optional additional reference sources. Always an
   *  array (empty when none). */
  referenceUrls: ReadonlyArray<string>;
  /**
   * Account age in days, derived from growth_accounts.created_at.
   * Drives new-account safety caps inside the platform-native
   * adapter and QA. Always >= 0; defaults to 0 if createdAt parses
   * as invalid.
   */
  ageDays: number;
  /**
   * Narrowed identity lifecycle. Mirrors growth_accounts.status with
   * a defensive fallback to "active" when an unrecognised value is
   * stored (older rows from pre-typing).
   */
  lifecycleStatus: IdentityLifecycleStatus;
  associatedProduct: {
    id: string;
    name: string;
    domain: string | null;
    summary: string | null;
    category: string | null;
  } | null;
  /** Most recent successful publishes for this identity's workspace+platform. */
  publishingHistory: Array<{
    permalink: string | null;
    publishedAt: string;
    titleHash: string | null;
  }>;
  /** Editorial guidance about how this platform reads. */
  platformGuidance: FounderPlatformGuidance | null;
}

const LIFECYCLE_STATUSES: ReadonlySet<IdentityLifecycleStatus> = new Set([
  "planned",
  "warming",
  "active",
  "paused",
  "setup_needed",
  "awaiting_manual_creation",
  "archived",
]);

function narrowLifecycle(raw: string | null | undefined): IdentityLifecycleStatus {
  if (typeof raw === "string" && LIFECYCLE_STATUSES.has(raw as IdentityLifecycleStatus)) {
    return raw as IdentityLifecycleStatus;
  }
  return "active";
}

function ageDaysFromCreatedAt(createdAt: string | null | undefined): number {
  if (!createdAt) return 0;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  return days < 0 ? 0 : Math.floor(days);
}

/**
 * Build the full context for a single publishing identity. Returns
 * null when the identity can't be loaded (cross-workspace access,
 * archived, deleted, etc.).
 */
export async function getPublishingIdentityContext(input: {
  workspaceId: string;
  identityId: string;
  /** How many recent successful publishes to include. Default 5. */
  historyLimit?: number;
  /**
   * Optional injected Supabase client. The UI / server-action path
   * omits it so each repo picks up the cookie-aware client.
   * MCP-driven callers (signal.generate_draft, signal.generate_
   * weekly_plan, signal.generate_multiweek_plan) pass the service-
   * role client (ctx.db) so the repo lookups don't depend on a
   * Supabase session cookie that doesn't exist for bearer-token
   * MCP requests.
   */
  db?: SupabaseClient;
}): Promise<PublishingIdentityContext | null> {
  let identity;
  try {
    identity = await getAccountById(input.workspaceId, input.identityId, input.db);
  } catch {
    return null;
  }

  const associatedProduct = identity.productId
    ? await getProductById(
        input.workspaceId,
        identity.productId,
        input.db,
      ).catch(() => null)
    : null;

  const limit = input.historyLimit ?? 5;
  const allRecent = await listRecentPublishes(
    input.workspaceId,
    30,
    input.db,
  );
  const publishingHistory = allRecent
    .filter(
      (p) => p.outcome === "published" && p.platform === identity.platform,
    )
    .slice(0, limit)
    .map((p) => ({
      permalink: p.providerPermalink,
      publishedAt: p.finishedAt,
      titleHash: p.titleHash,
    }));

  return {
    identityId: identity.id,
    platform: identity.platform,
    platformLabel: friendlyPlatformLabel(identity.platform),
    displayName: identity.displayName,
    handle: identity.handle,
    // Prefer the new voice_profile column. Fall back to the legacy
    // role column for unmigrated rows so MCP still has something to
    // read (the migration already backfills this; the fallback covers
    // pre-migration test environments).
    voiceProfile: identity.voiceProfile ?? identity.role ?? null,
    sourceWebsiteUrl: identity.sourceWebsiteUrl,
    referenceUrls: identity.referenceUrls,
    ageDays: ageDaysFromCreatedAt(identity.createdAt),
    lifecycleStatus: narrowLifecycle(identity.status),
    associatedProduct: associatedProduct
      ? {
          id: associatedProduct.id,
          name: associatedProduct.name,
          domain: associatedProduct.domain,
          summary: associatedProduct.summary,
          category: associatedProduct.category,
        }
      : null,
    publishingHistory,
    platformGuidance: resolveIdentityPlatformGuidance(identity.platform),
  };
}

/**
 * Lightweight selector for the voice profile alone. Useful when
 * generation only needs the writing-style context and not the full
 * identity. Returns an empty string when no profile is set, so
 * callers can string-concatenate without null guards.
 */
export function formatIdentityVoiceProfile(
  context: PublishingIdentityContext | null,
): string {
  if (!context) return "";
  const profile = context.voiceProfile?.trim();
  if (profile && profile.length > 0) return profile;
  return "";
}
