import type { ConfidentField, ExtractionQuality } from "./field-mapping";
import { summarizeExtraction } from "./field-mapping";

/**
 * Account-screenshot extraction contract. The MCP/AI side fills this
 * shape; Signal validates and presents it for confirmation. The user is
 * always the final approver.
 *
 * Hard rules — never extract or store:
 *   - passwords
 *   - cookies / session tokens
 *   - 2FA / recovery codes
 *   - DM / private message content
 *   - account email addresses (the user provides them separately)
 *
 * The screenshot itself is never persisted by default; only the
 * extracted fields are.
 */
export const SCREENSHOT_ACCOUNT_PLATFORMS = [
  "reddit",
  "x",
  "linkedin",
  "google",
  "unknown",
] as const;

export type ScreenshotAccountPlatform =
  (typeof SCREENSHOT_ACCOUNT_PLATFORMS)[number];

export interface ScreenshotAccountExtraction {
  platform: ScreenshotAccountPlatform;
  handle: ConfidentField<string>;
  display_name: ConfidentField<string>;
  bio: ConfidentField<string>;
  profile_url: ConfidentField<string>;
  visible_status: ConfidentField<string>;
  warnings: string[];
  requires_user_confirmation: true;
}

export function emptyAccountExtraction(): ScreenshotAccountExtraction {
  return {
    platform: "unknown",
    handle: { value: null, confidence: 0 },
    display_name: { value: null, confidence: 0 },
    bio: { value: null, confidence: 0 },
    profile_url: { value: null, confidence: 0 },
    visible_status: { value: null, confidence: 0 },
    warnings: [],
    requires_user_confirmation: true,
  };
}

export function summarizeAccountExtraction(
  e: ScreenshotAccountExtraction,
): ExtractionQuality {
  return summarizeExtraction({
    handle: e.handle,
    display_name: e.display_name,
    bio: e.bio,
    profile_url: e.profile_url,
    visible_status: e.visible_status,
  });
}

/**
 * Product extraction contract. Inputs may be a screenshot, a pasted
 * landing-page block, or a free-form description — the output shape is
 * the same.
 *
 * Hard rules:
 *   - Do not invent claims. If uncertain, leave `value: null` and add a
 *     warning string.
 *   - `blocked_claims` is a curated list of phrases this product should
 *     never use (e.g. "10x your revenue") — derived from the source,
 *     never invented.
 */
export interface ScreenshotProductExtraction {
  name: ConfidentField<string>;
  domain: ConfidentField<string>;
  category: ConfidentField<string>;
  short_summary: ConfidentField<string>;
  audience: ConfidentField<string>;
  positioning: ConfidentField<string>;
  allowed_topics: ConfidentField<string[]>;
  blocked_claims: ConfidentField<string[]>;
  warnings: string[];
  requires_user_confirmation: true;
}

export function emptyProductExtraction(): ScreenshotProductExtraction {
  const blank = { value: null, confidence: 0 } as const;
  return {
    name: blank,
    domain: blank,
    category: blank,
    short_summary: blank,
    audience: blank,
    positioning: blank,
    allowed_topics: { value: null, confidence: 0 },
    blocked_claims: { value: null, confidence: 0 },
    warnings: [],
    requires_user_confirmation: true,
  };
}

export function summarizeProductExtraction(
  e: ScreenshotProductExtraction,
): ExtractionQuality {
  return summarizeExtraction({
    name: e.name,
    domain: e.domain,
    category: e.category,
    short_summary: e.short_summary,
    audience: e.audience,
    positioning: e.positioning,
    allowed_topics: e.allowed_topics,
    blocked_claims: e.blocked_claims,
  });
}

/**
 * Encodes the hard "don't extract" list as constants so any
 * cross-checking layer can grep for the canonical names.
 */
export const NEVER_EXTRACT_FIELDS = [
  "password",
  "cookie",
  "session_token",
  "two_factor_code",
  "recovery_code",
  "private_message",
] as const;

export type NeverExtractField = (typeof NEVER_EXTRACT_FIELDS)[number];
