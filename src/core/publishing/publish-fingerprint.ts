/**
 * Phase F2.5 — duplicate-content fingerprints.
 *
 * Builds a stable hash from the canonicalized publish payload so we
 * can refuse a re-post of the same content within a window
 * (typically 30 days). Also computes per-field hashes (title, body)
 * for narrower checks.
 *
 * Canonicalization:
 *   - lowercase
 *   - strip URLs (so the same post text with the same campaign UTM
 *     still hashes the same)
 *   - collapse whitespace
 *   - trim
 */

import "server-only";

const URL_RE = /\bhttps?:\/\/\S+/gi;

export function canonicalize(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(URL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface FingerprintInput {
  platform: string;
  subreddit: string | null;
  title: string | null;
  body: string | null;
  linkUrl: string | null;
}

export interface Fingerprint {
  fingerprint: string;
  titleHash: string;
  bodyHash: string;
}

export async function computeFingerprint(
  input: FingerprintInput,
): Promise<Fingerprint> {
  const title = canonicalize(input.title);
  const body = canonicalize(input.body);
  const sub = (input.subreddit ?? "").toLowerCase().trim();
  const link = (input.linkUrl ?? "").toLowerCase().trim();
  const compound = `${input.platform}|${sub}|${title}|${body}|${link}`;
  const [fp, th, bh] = await Promise.all([
    sha256(compound),
    sha256(title),
    sha256(body),
  ]);
  return { fingerprint: fp, titleHash: th, bodyHash: bh };
}
