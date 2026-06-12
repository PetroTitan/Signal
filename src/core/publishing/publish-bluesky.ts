import "server-only";
/**
 * Phase F4 — Bluesky publisher (AT Protocol).
 *
 * Bluesky requires session authentication via `com.atproto.server.createSession`,
 * then post records are created with `com.atproto.repo.createRecord` against
 * the collection `app.bsky.feed.post`.
 *
 * We do NOT use @atproto/api — it's a heavy SDK with its own auth lifecycle.
 * Plain fetch against documented endpoints is enough for the publish-only flow.
 *
 * Reference:
 *   - https://docs.bsky.app/docs/api/com-atproto-server-create-session
 *   - https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 *
 * Threading:
 *   - first post: no reply ref
 *   - subsequent posts: reply.root = first, reply.parent = previous
 *
 * NEVER:
 *   - persists the access JWT (it lives only in the closure of one publish call)
 *   - logs the app password
 *   - retries automatically
 */

import { publishBlocked, publishFail, publishOk } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";
import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";
import { extractFacets } from "./transformers/bluesky-facets";
import {
  formatBlueskyReasonDetail,
  mapBlueskyAtprotoErrorToReasonCode,
  readBlueskyErrorBody,
  type BlueskyErrorBody,
} from "./atproto-error-body";
import {
  prepareBlueskyThreadPayload,
  type BlueskyPayloadMedia,
  type BlueskyPayloadResult,
} from "./bluesky-payload";
import {
  prepareProviderMedia,
  getProviderImageLimitBytes,
} from "@/core/creatives/provider-media-prep";

export interface PublishBlueskyInput {
  request: PublishRequest;
  identifier: string;
  appPassword: string;
  service: string;
}

/**
 * Identity-scoped publish input. The caller provides an already-
 * decrypted access JWT + the DID this session belongs to. The
 * publisher uses these directly — no createSession round-trip, no
 * app password handling.
 *
 * The caller (the runner) is responsible for refresh-on-401:
 * `session_expired` is returned as a typed outcome so the runner can
 * orchestrate refresh + retry exactly once. The publisher itself
 * never retries.
 */
export interface PublishBlueskyAsIdentityInput {
  request: PublishRequest;
  /** Decrypted access JWT. Held only in this call's scope. */
  accessJwt: string;
  /** The DID that owns the session (= repo for createRecord). */
  did: string;
  /** The canonical handle for this identity. Drives the permalink. */
  handle: string;
  /** AT Protocol PDS service URL, e.g. https://bsky.social */
  service: string;
}

interface BlueskySession {
  accessJwt: string;
  did: string;
}

interface CreateRecordResponse {
  uri: string;
  cid: string;
}

interface SessionFailure {
  ok: false;
  status: number;
  detail: string;
  /** Structured AT Proto error captured from the response body.
   *  Null when the failure happened before we received a response
   *  (network / timeout) or when the body was empty. */
  errorBody: BlueskyErrorBody | null;
}

async function createSession(
  service: string,
  identifier: string,
  password: string,
): Promise<{ ok: true; session: BlueskySession } | SessionFailure> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${service}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
        timeoutMs: 15_000,
      },
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Bluesky login timed out (15s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
      errorBody: null,
    };
  }
  if (resp.status === 401) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: 401,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createSession", 401, errorBody)
          : "Bluesky rejected the identifier/app-password.",
      errorBody,
    };
  }
  if (!resp.ok) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail: formatBlueskyReasonDetail("createSession", resp.status, errorBody),
      errorBody,
    };
  }
  let json: { accessJwt?: string; did?: string };
  try {
    json = (await resp.json()) as { accessJwt?: string; did?: string };
  } catch {
    return {
      ok: false,
      status: resp.status,
      detail: "createSession response was not JSON",
      errorBody: null,
    };
  }
  if (!json.accessJwt || !json.did) {
    return {
      ok: false,
      status: resp.status,
      detail: "createSession response missing accessJwt or did",
      errorBody: null,
    };
  }
  return { ok: true, session: { accessJwt: json.accessJwt, did: json.did } };
}

interface CreateRecordFailure {
  ok: false;
  status: number;
  detail: string;
  /** Structured AT Proto error captured from the response body.
   *  Null when the failure happened before we received a response
   *  (network / timeout) or when the body was empty / unreadable. */
  errorBody: BlueskyErrorBody | null;
}

async function createPostRecord(
  service: string,
  session: BlueskySession,
  record: Record<string, unknown>,
): Promise<{ ok: true; record: CreateRecordResponse } | CreateRecordFailure> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${service}/xrpc/com.atproto.repo.createRecord`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repo: session.did,
          collection: "app.bsky.feed.post",
          record,
        }),
        timeoutMs: 20_000,
      },
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Bluesky didn't respond in time (20s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "network error",
      errorBody: null,
    };
  }
  if (resp.status === 401 || resp.status === 403) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createRecord", resp.status, errorBody)
          : `Bluesky returned ${resp.status} — session may have been revoked.`,
      errorBody,
    };
  }
  if (resp.status === 429) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: 429,
      detail:
        errorBody.atproto_error || errorBody.atproto_message
          ? formatBlueskyReasonDetail("createRecord", 429, errorBody)
          : "Bluesky returned 429",
      errorBody,
    };
  }
  if (!resp.ok) {
    const errorBody = await readBlueskyErrorBody(resp);
    return {
      ok: false,
      status: resp.status,
      detail: formatBlueskyReasonDetail("createRecord", resp.status, errorBody),
      errorBody,
    };
  }
  let json: { uri?: string; cid?: string };
  try {
    json = (await resp.json()) as { uri?: string; cid?: string };
  } catch {
    return {
      ok: false,
      status: resp.status,
      detail: "createRecord response was not JSON",
      errorBody: null,
    };
  }
  if (!json.uri || !json.cid) {
    return {
      ok: false,
      status: resp.status,
      detail: "createRecord response missing uri or cid",
      errorBody: null,
    };
  }
  return { ok: true, record: { uri: json.uri, cid: json.cid } };
}

// =====================================================================
// uploadBlob — required by Bluesky to attach an image to a post.
// =====================================================================
//
// AT Proto image flow:
//   1. POST /xrpc/com.atproto.repo.uploadBlob with raw image bytes.
//      The PDS returns a `blob` object (`{ $type:"blob", ref, mimeType,
//      size }`) that's the durable handle.
//   2. The blob object goes directly into the post record's
//      `embed.images[0].image`. The record write is what makes the
//      image actually appear on the feed; the upload alone does
//      nothing visible.
//
// We perform exactly one blob upload per scheduled publish (the
// approved primary creative) and attach it to the FIRST thread post
// only. Multi-image attachments and thread-wide gallery support are
// deferred.

/** Opaque blob handle returned by AT Proto's uploadBlob. We never
 *  inspect the inner fields; the publisher just embeds it verbatim
 *  in the post record. */
interface BlueskyBlob {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface UploadBlobFailure {
  ok: false;
  status: number;
  detail: string;
  errorBody: BlueskyErrorBody | null;
  /** Set when the failure is "image exceeds Bluesky's blob limit",
   *  detected in-flight from the fetched bytes BEFORE the uploadBlob
   *  POST. The caller maps this to `media_too_large_for_platform`
   *  (a provider-prep block) rather than a generic upload failure. */
  tooLarge?: boolean;
}

/**
 * Bluesky-supported image MIME types. Anything else is rejected
 * client-side so we don't pay a round-trip just to discover the
 * platform won't accept it. List sourced from Bluesky's PDS
 * tolerance (jpeg, png, webp, gif); see
 * https://docs.bsky.app/docs/api/com-atproto-repo-upload-blob
 */
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function guessImageMimeType(url: string, contentTypeHeader: string | null): string | null {
  if (contentTypeHeader) {
    const headerMime = contentTypeHeader.split(";")[0]?.trim().toLowerCase();
    if (headerMime && SUPPORTED_IMAGE_MIME_TYPES.has(headerMime)) {
      return headerMime;
    }
  }
  const lower = url.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

/**
 * Fetch the image bytes from `imageUrl` and upload them to the
 * caller's Bluesky PDS as a blob. Returns the blob handle that the
 * caller embeds in the first post record.
 *
 * All failure modes (network, mime, fetch non-2xx, upload non-2xx)
 * produce a structured `UploadBlobFailure` so the publish caller
 * can surface `media_upload_failed` with a real reason.
 */
async function uploadImageToBlueskyBlob(input: {
  service: string;
  accessJwt: string;
  imageUrl: string;
}): Promise<{ ok: true; blob: BlueskyBlob } | UploadBlobFailure> {
  const { service, accessJwt, imageUrl } = input;

  // 1. Fetch the image.
  let imageResp: Response;
  try {
    imageResp = await fetchWithTimeout(imageUrl, {
      method: "GET",
      timeoutMs: 20_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Image fetch timed out (20s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "Image fetch network error",
      errorBody: null,
    };
  }
  if (!imageResp.ok) {
    return {
      ok: false,
      status: imageResp.status,
      detail: `Image fetch returned ${imageResp.status} from creative asset URL.`,
      errorBody: null,
    };
  }
  const contentType = imageResp.headers.get("content-type");
  const mimeType = guessImageMimeType(imageUrl, contentType);
  if (!mimeType) {
    return {
      ok: false,
      status: 0,
      detail: `Unsupported image MIME for Bluesky (got "${contentType ?? "unknown"}"). Supported: image/jpeg, image/png, image/webp, image/gif.`,
      errorBody: null,
    };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await imageResp.arrayBuffer();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail:
        err instanceof Error ? err.message : "Image body read failed",
      errorBody: null,
    };
  }
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      status: 0,
      detail: "Image fetch returned empty body.",
      errorBody: null,
    };
  }

  // 1b. In-flight provider-media guard. Bluesky's uploadBlob rejects
  //     images over 2,000,000 bytes with "blob too big". We check the
  //     fetched byte length against the provider-safe ceiling (1.9 MB)
  //     BEFORE the uploadBlob POST, so an oversized creative is blocked
  //     with an actionable reason instead of an opaque PDS 400 — and
  //     crucially before any createRecord call. This catches creatives
  //     whose stored size_bytes was unknown/stale at scheduler time.
  const blueskyImageLimit = getProviderImageLimitBytes("bluesky");
  if (blueskyImageLimit !== null && bytes.byteLength > blueskyImageLimit) {
    return {
      ok: false,
      status: 0,
      detail: `Image is ${(bytes.byteLength / (1024 * 1024)).toFixed(2)} MB; Bluesky's per-image limit is ${(blueskyImageLimit / (1024 * 1024)).toFixed(2)} MB. Replace it with a smaller / more compressed image, then re-approve.`,
      errorBody: null,
      tooLarge: true,
    };
  }

  // 2. Upload the blob to the PDS.
  let uploadResp: Response;
  try {
    uploadResp = await fetchWithTimeout(
      `${service}/xrpc/com.atproto.repo.uploadBlob`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessJwt}`,
          "Content-Type": mimeType,
        },
        body: bytes,
        timeoutMs: 30_000,
      },
    );
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        ok: false,
        status: 0,
        detail: "Bluesky uploadBlob timed out (30s).",
        errorBody: null,
      };
    }
    return {
      ok: false,
      status: 0,
      detail:
        err instanceof Error ? err.message : "uploadBlob network error",
      errorBody: null,
    };
  }
  if (!uploadResp.ok) {
    const errorBody = await readBlueskyErrorBody(uploadResp);
    return {
      ok: false,
      status: uploadResp.status,
      detail: formatBlueskyReasonDetail(
        "uploadBlob",
        uploadResp.status,
        errorBody,
      ),
      errorBody,
    };
  }
  let json: { blob?: BlueskyBlob };
  try {
    json = (await uploadResp.json()) as { blob?: BlueskyBlob };
  } catch {
    return {
      ok: false,
      status: uploadResp.status,
      detail: "uploadBlob response was not JSON",
      errorBody: null,
    };
  }
  if (
    !json.blob ||
    typeof json.blob.ref?.$link !== "string" ||
    typeof json.blob.mimeType !== "string"
  ) {
    return {
      ok: false,
      status: uploadResp.status,
      detail: "uploadBlob response missing blob handle",
      errorBody: null,
    };
  }
  return { ok: true, blob: json.blob };
}

/** Build the AT Proto `embed.images` payload for a single image. */
function buildImageEmbed(
  blob: BlueskyBlob,
  altText: string,
): Record<string, unknown> {
  return {
    $type: "app.bsky.embed.images",
    images: [{ alt: altText, image: blob }],
  };
}

/**
 * Convert an at-uri (at://<did>/app.bsky.feed.post/<rkey>) to a
 * bsky.app permalink. Bluesky doesn't return a permalink directly,
 * so we synthesize one.
 */
function atUriToBskyPermalink(uri: string, handle: string): string | null {
  const m = uri.match(/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/);
  if (!m) return null;
  const rkey = m[1];
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/**
 * Metadata-based provider-media preflight for Bluesky.
 *
 * Runs BEFORE any blob fetch/upload using the creative's STORED
 * mime/size (carried on `request.creative`). When the stored size is
 * known and over Bluesky's per-image ceiling — or the type/kind isn't
 * publishable (e.g. video) — the publish is blocked with an actionable
 * reason and the provider API is never called. When size is unknown
 * (manual-URL creatives), this passes and the in-flight byte guard in
 * `uploadImageToBlueskyBlob` is the backstop.
 *
 * Returns the prep metadata to attach to the eventual publish so
 * execution_logs records the preparation outcome.
 */
async function blueskyMediaPreflight(
  request: PublishRequest,
): Promise<
  | { kind: "ok"; metadata: Record<string, unknown> }
  | { kind: "blocked"; outcome: PublishOutcome }
> {
  if (!request.creative) return { kind: "ok", metadata: {} };
  const prep = await prepareProviderMedia({
    platform: "bluesky",
    mimeType: request.creative.mimeType ?? null,
    sizeBytes: request.creative.sizeBytes ?? null,
    creativeType: request.creative.creativeType,
    originalCreativeId: request.creative.id,
  });
  if (prep.status === "blocked") {
    return {
      kind: "blocked",
      outcome: publishBlocked(
        prep.reasonCode ?? "media_upload_failed",
        `Bluesky: ${prep.reasonDetail ?? "Creative cannot be prepared for Bluesky."}`,
        {
          creative_id: request.creative.id,
          media_mode: "bluesky_image",
          ...prep.metadata,
        },
      ),
    };
  }
  return {
    kind: "ok",
    metadata: { media_mode: "bluesky_image", ...prep.metadata },
  };
}

export async function publishToBluesky(
  input: PublishBlueskyInput,
): Promise<PublishOutcome> {
  const { request, identifier, appPassword, service } = input;

  if (!identifier || !appPassword) {
    return publishFail(
      "missing_identifier",
      "Bluesky: set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Bluesky posts need body text.");
  }

  // 1. Create a session.
  const sessionResult = await createSession(service, identifier, appPassword);
  if (!sessionResult.ok) {
    // Body error trumps HTTP status. createSession is the
    // app-password login; default401 = platform_unauthorized because
    // there's no refresh story for a failed login.
    const code = mapBlueskyAtprotoErrorToReasonCode(
      sessionResult.errorBody,
      sessionResult.status,
      "platform_unauthorized",
    );
    return publishFail(code, `Bluesky: ${sessionResult.detail}`, {
      http_status: sessionResult.status,
      endpoint: "createSession",
      ...errorBodyMetadata(sessionResult.errorBody),
    });
  }
  const { session } = sessionResult;

  // 2. Build the shared payload (text parts + media metadata). Both
  // preview and publisher route through this single function so they
  // can't disagree about thread shape or media placement.
  const payload = prepareBlueskyThreadPayload({
    title: request.title,
    body: request.body ?? "",
    creative: request.creative
      ? {
          id: request.creative.id,
          assetUrl: request.creative.assetUrl,
          sourceUrl: request.creative.sourceUrl,
          altText: request.creative.altText,
          creativeType: request.creative.creativeType,
        }
      : null,
  });
  if (payload.kind === "empty_body") {
    return publishFail("missing_body", `Bluesky: ${payload.reasonDetail}`);
  }
  if (payload.creativeBlocked) {
    return publishBlocked(
      payload.creativeBlocked.reasonCode,
      `Bluesky: ${payload.creativeBlocked.reasonDetail}`,
      { creative_id: request.creative?.id ?? null },
    );
  }

  // 2a. Provider-media preflight (size/format/kind) BEFORE any upload.
  const mediaPreflight = await blueskyMediaPreflight(request);
  if (mediaPreflight.kind === "blocked") return mediaPreflight.outcome;

  // 2b. Upload the blob now if the payload calls for media. Embed
  // metadata is added at record-build time using the AT Proto blob
  // handle the upload returns.
  const uploaded = await maybeUploadMediaForPayload({
    media: payload.media,
    service,
    accessJwt: session.accessJwt,
    // App-password path can't refresh — a 401 with no AT Proto error
    // body is a wrong-password problem, not an expired-token problem.
    default401: "platform_unauthorized",
  });
  if (uploaded.kind === "failed") return uploaded.outcome;

  // 3. Publish the thread, threading reply references.
  let rootUri: string | null = null;
  let rootCid: string | null = null;
  let previousUri: string | null = null;
  let previousCid: string | null = null;
  const createdAt = new Date().toISOString();

  for (const part of payload.parts) {
    const facets = extractFacets(part.text);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part.text,
      createdAt,
      langs: ["en"],
    };
    if (facets.length > 0) {
      record.facets = facets;
    }
    if (rootUri && rootCid && previousUri && previousCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: previousUri, cid: previousCid },
      };
    }
    // Shared payload owns the "first post only" decision.
    if (part.attachMedia && uploaded.kind === "embed") {
      record.embed = uploaded.embed;
    }
    const result = await createPostRecord(service, session, record);
    if (!result.ok) {
      // Body error trumps HTTP status. Legacy app-password publisher
      // has no refresh path; default401 = platform_unauthorized.
      const code = mapBlueskyAtprotoErrorToReasonCode(
        result.errorBody,
        result.status,
        "platform_unauthorized",
      );
      return publishFail(code, `Bluesky: ${result.detail}`, {
        http_status: result.status,
        endpoint: "createRecord",
        thread_position_failed: part.index,
        thread_total: part.total,
        ...errorBodyMetadata(result.errorBody),
      });
    }
    if (!rootUri) {
      rootUri = result.record.uri;
      rootCid = result.record.cid;
    }
    previousUri = result.record.uri;
    previousCid = result.record.cid;
  }

  // 4. Synthesize the permalink for the root post.
  const handle = identifier.includes(".") ? identifier : null;
  const permalink =
    rootUri && handle ? atUriToBskyPermalink(rootUri, handle) : null;

  return publishOk({
    externalId: rootUri,
    externalUrl: permalink,
    metadata: {
      thread_length: payload.parts.length,
      root_uri: rootUri,
      media_attached: uploaded.kind === "embed",
      ...mediaPreflight.metadata,
    },
  });
}

// =====================================================================
// Identity-scoped publish — the correct model.
// =====================================================================
//
// publishToBlueskyAsIdentity uses the encrypted session already
// owned by THIS identity (via /api/identity/[id]/bluesky/connect),
// never the workspace-level BLUESKY_APP_PASSWORD. The runner
// decrypts the access JWT, calls this function, and on 401 handles
// refresh + retry orchestration externally.
//
// The function is pure (modulo fetch) and identity-scoped:
//   - repo = input.did      → posts always land on this identity's account
//   - Authorization Bearer  → uses this identity's session only
// Two identities passing two different (did, accessJwt) values can
// NEVER cross-pollinate — the function reads only what was passed in.

/**
 * Publishes the canonical post under the given identity's session.
 *
 * Returns one of three outcomes via the standard PublishOutcome:
 *   - ok: publish succeeded
 *   - fail("session_expired", ...): server returned 401. The runner
 *     should attempt refresh exactly once.
 *   - other failure codes: rate-limited, network, malformed input
 */
export async function publishToBlueskyAsIdentity(
  input: PublishBlueskyAsIdentityInput,
): Promise<PublishOutcome> {
  const { request, accessJwt, did, handle, service } = input;

  if (!accessJwt || !did) {
    return publishFail(
      "session_missing",
      "Bluesky: identity is not signed in.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Bluesky posts need body text.");
  }

  // Shared payload preparation — same source of truth as the
  // preview renderer.
  const payload = prepareBlueskyThreadPayload({
    title: request.title,
    body: request.body ?? "",
    creative: request.creative
      ? {
          id: request.creative.id,
          assetUrl: request.creative.assetUrl,
          sourceUrl: request.creative.sourceUrl,
          altText: request.creative.altText,
          creativeType: request.creative.creativeType,
        }
      : null,
  });
  if (payload.kind === "empty_body") {
    return publishFail("missing_body", `Bluesky: ${payload.reasonDetail}`);
  }
  if (payload.creativeBlocked) {
    return publishBlocked(
      payload.creativeBlocked.reasonCode,
      `Bluesky: ${payload.creativeBlocked.reasonDetail}`,
      { creative_id: request.creative?.id ?? null },
    );
  }

  // Provider-media preflight (size/format/kind) BEFORE any upload.
  const mediaPreflight = await blueskyMediaPreflight(request);
  if (mediaPreflight.kind === "blocked") return mediaPreflight.outcome;

  // Upload the approved creative (if any) before the thread loop.
  // First post gets the embed; subsequent posts are reply records.
  const uploaded = await maybeUploadMediaForPayload({
    media: payload.media,
    service,
    accessJwt,
    // Identity-scoped path can refresh — a 401 with no AT Proto error
    // body is an aged-out access JWT; the orchestrator's
    // refresh-and-retry path is gated on `session_expired`.
    default401: "session_expired",
  });
  if (uploaded.kind === "failed") return uploaded.outcome;

  const session: BlueskySession = { accessJwt, did };
  const createdAt = new Date().toISOString();
  let rootUri: string | null = null;
  let rootCid: string | null = null;
  let previousUri: string | null = null;
  let previousCid: string | null = null;

  for (const part of payload.parts) {
    const facets = extractFacets(part.text);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text: part.text,
      createdAt,
      langs: ["en"],
    };
    if (facets.length > 0) record.facets = facets;
    if (rootUri && rootCid && previousUri && previousCid) {
      record.reply = {
        root: { uri: rootUri, cid: rootCid },
        parent: { uri: previousUri, cid: previousCid },
      };
    }
    // Shared payload owns the "first post only" decision.
    if (part.attachMedia && uploaded.kind === "embed") {
      record.embed = uploaded.embed;
    }
    const result = await createPostRecord(service, session, record);
    if (!result.ok) {
      // Body error trumps HTTP status. The identity-scoped path
      // wants 401 (and AT Proto body errors ExpiredToken /
      // InvalidToken regardless of HTTP status) to surface as
      // session_expired so the orchestrator's refresh-and-retry
      // path fires. 403 / AccountTakedown / AuthFactorTokenRequired
      // mean refresh won't help — they bubble up as
      // platform_unauthorized so the operator intervenes.
      const code = mapBlueskyAtprotoErrorToReasonCode(
        result.errorBody,
        result.status,
        "session_expired",
      );
      return publishFail(code, `Bluesky: ${result.detail}`, {
        http_status: result.status,
        endpoint: "createRecord",
        thread_position_failed: part.index,
        thread_total: part.total,
        // The DID is public information — already in the at-uri of
        // any of this identity's published posts. Including it in
        // diagnostic metadata is safe.
        did,
        ...errorBodyMetadata(result.errorBody),
      });
    }
    if (!rootUri) {
      rootUri = result.record.uri;
      rootCid = result.record.cid;
    }
    previousUri = result.record.uri;
    previousCid = result.record.cid;
  }

  const permalink = rootUri ? atUriToBskyPermalink(rootUri, handle) : null;

  return publishOk({
    externalId: rootUri,
    externalUrl: permalink,
    metadata: {
      thread_length: payload.parts.length,
      root_uri: rootUri,
      media_attached: uploaded.kind === "embed",
      ...mediaPreflight.metadata,
      // No tokens, no app passwords. DID is public and useful for
      // operator audit ("which exact account did this post under?").
      did,
    },
  });
}

/**
 * Upload the prepared media (when present) and produce the AT Proto
 * `embed` object the first record will carry. Returns:
 *
 *   - `none`   — payload.media was null; no upload attempted.
 *   - `embed`  — upload succeeded; the caller embeds on the first
 *                record (the shared payload already decided which
 *                part attaches media).
 *   - `failed` — upload or pre-flight fetch failed; the caller
 *                returns this PublishOutcome directly so the
 *                operator sees `media_upload_failed` rather than a
 *                silent text-only publish.
 *
 * Validation (URL + alt text presence) lives in
 * `bluesky-payload.ts`; by the time we reach this function the
 * payload guarantees both fields are non-empty.
 */
type MediaUploadResult =
  | { kind: "none" }
  | { kind: "embed"; embed: Record<string, unknown> }
  | { kind: "failed"; outcome: PublishOutcome };

async function maybeUploadMediaForPayload(input: {
  media: BlueskyPayloadMedia | null;
  service: string;
  accessJwt: string;
  /** What the caller wants for a 401 with no structured AT Proto
   *  body error. Identity-scoped publish passes "session_expired" so
   *  the orchestrator's refresh-and-retry path fires; app-password
   *  publish passes "platform_unauthorized" (no refresh story). */
  default401: "session_expired" | "platform_unauthorized";
}): Promise<MediaUploadResult> {
  const media = input.media;
  if (!media) return { kind: "none" };
  const upload = await uploadImageToBlueskyBlob({
    service: input.service,
    accessJwt: input.accessJwt,
    imageUrl: media.imageUrl,
  });
  if (!upload.ok && upload.tooLarge) {
    // Provider-media block: the image exceeds Bluesky's blob limit.
    // This is NOT a token / network failure — surface it as a clean
    // "replace the creative" block (no silent text-only downgrade).
    return {
      kind: "failed",
      outcome: publishBlocked(
        "media_too_large_for_platform",
        `Bluesky: ${upload.detail}`,
        {
          endpoint: "uploadBlob",
          media_mode: "bluesky_image",
          media_preparation_status: "blocked",
          provider_media_limit_bytes: getProviderImageLimitBytes("bluesky"),
          creative_id: media.creativeId,
        },
      ),
    };
  }
  if (!upload.ok) {
    // Body error trumps HTTP status — bsky.social returns
    // ExpiredToken / InvalidToken on HTTP 400 in the wild for
    // uploadBlob just as it does for createRecord. Route through the
    // same mapper so the orchestrator's refresh-and-retry path can
    // recover the recoverable cases.
    //
    // We only widen past "media_upload_failed" for codes the mapper
    // positively identified — session_expired (recoverable),
    // platform_unauthorized (operator must intervene), or
    // platform_rate_limited. Everything else (genuine media failures
    // like "Blob size exceeds maximum") stays "media_upload_failed"
    // so the operator-facing classification remains media-specific.
    const mapped = mapBlueskyAtprotoErrorToReasonCode(
      upload.errorBody,
      upload.status,
      input.default401,
    );
    const code = mapped === "platform_api_error" ? "media_upload_failed" : mapped;
    return {
      kind: "failed",
      outcome: publishFail(code, `Bluesky: ${upload.detail}`, {
        endpoint: "uploadBlob",
        http_status: upload.status,
        creative_id: media.creativeId,
        ...errorBodyMetadata(upload.errorBody),
      }),
    };
  }
  return {
    kind: "embed",
    embed: buildImageEmbed(upload.blob, media.altText),
  };
}

/**
 * Flatten the structured `BlueskyErrorBody` into the keys we want to
 * land in PublishOutcome.metadata. Returns an empty object when the
 * body was null (network/timeout) so the spread is a no-op.
 *
 * Output keys (all optional):
 *   - atproto_error
 *   - atproto_message
 *   - atproto_response_body_truncated
 *   - atproto_response_body_was_truncated
 */
function errorBodyMetadata(
  body: BlueskyErrorBody | null,
): Record<string, unknown> {
  if (!body) return {};
  return {
    atproto_error: body.atproto_error,
    atproto_message: body.atproto_message,
    atproto_response_body_truncated: body.atproto_response_body_truncated,
    atproto_response_body_was_truncated: body.atproto_response_body_was_truncated,
  };
}
