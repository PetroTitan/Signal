# Provider Video Preparation — Audit & Design

**Status:** Design / plan only. No code, dependencies, runtime, or publishing adapters are changed by this document.
**Scope:** Video media preparation design for future automated publishing (X, Instagram, Threads, YouTube, Telegram, possibly Bluesky).
**Builds on:** Provider-aware **image** preparation (Phase 1) and **image derivatives** (Phase 2), both merged to `main`.

> **Hard rule (read first):** Do **not** run `ffmpeg` transcoding in the request/response publish path. The runtime audit (§4) shows it is unsafe on Vercel defaults (timeout + memory + bundle size). Video transcoding must run as an async job / external worker. Publish-time code may only **consume** an already-prepared derivative or **block** cleanly.

---

## 1. Audit findings

### 1.1 Creative upload policy
Source: `src/core/publishing/creative-upload-policy.ts`, migration `supabase/migrations/20260523000002_phase_f2_5_creative_storage.sql`.

| Aspect | Current state |
|---|---|
| Video MIME allow-list | `video/mp4`, `video/webm` only |
| Max upload size | `MAX_VIDEO_BYTES = 100 MB` (images `MAX_IMAGE_BYTES = 10 MB`) |
| Storage bucket | `weekly-plan-creatives`: public-read, `file_size_limit = 104857600` (100 MB), MIME-whitelisted (mp4/webm included). Bucket RLS requires the **first path segment to be a workspace id** the user belongs to. |
| Duration / codec / bitrate / fps stored? | **No.** The `weekly_plan_item_creatives` row has `mime_type`, `size_bytes`, `storage_path`, `uploaded_at`, plus a free-form `metadata` JSONB. No video-specific columns; nothing populates duration/codec/bitrate. |
| Thumbnails / poster frames generated? | **No.** "thumbnail" in the codebase (`transformers/youtube.ts`, `platform-native/creative-direction.ts`) is **editorial guidance text** (a "thumbnail idea" the operator should design), not an extracted poster frame. |
| Videos approved / published anywhere? | **Approved: possible.** `platform-native/approval-policy.ts` requires a creative for `media_post` / `carousel` / `story` / `short_video` / `video_post`, and a video creative satisfies that. **Auto-published: nowhere** (see §1.3). Today video = *plan → approve → manual record*, never an automated upload. |

### 1.2 Current provider media preparation (image pipeline, Phases 1–2)
- `src/core/creatives/provider-media-prep.ts` — `PROVIDER_MEDIA_POLICY` carries `videoPublishSupported: false` for **every** platform. `classifyMediaKind()` returns `"video"` for `video/*`. `prepareProviderMedia()` blocks video with reason code `media_video_unsupported`, **before any provider call**. The per-platform `notes` already record future video constraints (e.g. Instagram "~1 GB / 5 min via the container API", YouTube "resumable upload + processing required").
- `PreparedDerivative` descriptor (image): `platform, originalCreativeId, mimeType, sizeBytes, width, height, storageRef, publicUrl, sourceSizeBytes, transform{ outputFormat, quality, maxWidth, maxHeight, targetBytes }, generatedAt`. The shape is intentionally future-proof — video derivatives slot in with the same fields plus duration/codec/poster.
- `metadata.provider_derivatives[platform]` JSONB — written by `recordProviderDerivative()` in `src/repositories/weekly-plan-creative-repository.ts` (merge-only, db-aware, **no schema change**).
- `src/core/creatives/image-derivative-transformer.ts` — **sharp**, still images only; rejects animated/multi-page sources; pluggable engine for tests.
- `src/core/creatives/resolve-provider-derivative.ts` — orchestrator-facing resolver returning `ready | derivative | blocked`; degrades to preflight-block when no storage client is available.
- **How video is blocked/deferred today:** at `prepareProviderMedia` for byte-upload platforms (Bluesky/X) via `media_video_unsupported`, before any provider call — so a scheduled X/Bluesky post with a video creative blocks with a clear reason and **no text-only downgrade**.

### 1.3 Current platform support (planning vs publishing)
The **planning/approval adapters** (`src/core/platform-native/adapters/*`) validate video *intents* — YouTube `video_post` / `short_video` (reserved), Instagram `media_post` / `story` (reserved) / `short_video` (reserved), Threads `media_post`, X `media_post`, LinkedIn `media_post`. **But no publisher uploads video:**

| Platform | Planning intent exists? | Auto-publish today |
|---|---|---|
| X | `media_post` | **No** — `uploadXMedia` is single **image** only; video → `media_video_unsupported` |
| Instagram | media_post / story / short_video | **No** — manual-distribution; runner returns `platform_not_supported` |
| Threads | media_post | **No** — manual-distribution |
| YouTube | video_post / short_video (reserved) | **No** — manual-distribution |
| Telegram | (photo path) | **No** — publisher is `sendPhoto` only |
| Bluesky | — | **No** — images only; `app.bsky.embed.video` not wired |
| dev.to / Hashnode | article | **N/A** — video is an embedded URL in markdown, not a native upload; low relevance |

Source: `src/core/publishing/publishing-runner.ts` (youtube/threads/instagram → `platform_not_supported`), `src/core/publishing/publish-x.ts`, `publish-telegram.ts`.

### 1.4 Runtime feasibility (Vercel)
- `vercel.json` declares only the cron (`/api/scheduler/tick`, every 5 min). There is **no `maxDuration`, `memory`, or `runtime` override anywhere** → Vercel **defaults** apply (function timeout ~10 s Hobby / 15 s Pro default, configurable to 300 s on Pro via `maxDuration`; default ~1024 MB memory, up to ~3008 MB). All publish code runs in the **Node** runtime (no Edge runtime anywhere).
- **ffprobe** (metadata) is fast (tens of ms) and low-memory → feasible in a function in principle.
- **ffmpeg transcoding** of up to a 100 MB video is **not safe** in the request/response publish path: it routinely exceeds the default timeout and can spike memory, and `ffmpeg-static` (~80 MB) alongside `sharp` risks exceeding the serverless bundle limit (~50 MB zipped / ~250 MB unzipped per function). **Conclusion: transcoding must be asynchronous / external.**

### 1.5 Summary of gaps to close
1. No video metadata extraction (duration/codec/container/dimensions/fps).
2. No poster/thumbnail extraction.
3. No video derivative generation.
4. No platform video upload adapters (all multi-step async flows).
5. No async job/worker infrastructure.

---

## 2. Platform video limit matrix

> Documented platform limits — **verify each at implementation time**; these APIs drift. The architecturally important column is **Upload model** — none is a single `fetch` like images.

| Platform | Container / codec | Max size | Max duration | Upload model |
|---|---|---|---|---|
| **X** | MP4, H.264 + AAC | ~512 MB | ~140 s (longer on some tiers) | **Chunked** media upload (INIT → APPEND → FINALIZE) + **async STATUS poll** |
| **Instagram** | MP4/MOV, H.264/HEVC + AAC; Reels 9:16 | ~1 GB (Reels) | Reels ~90 s; feed up to ~60 min | **Container** created from a **public URL** → poll status → publish |
| **Threads** | MP4/MOV, 9:16 | ~1 GB | ~5 min | **Container** from public URL → poll → publish |
| **YouTube** | most formats | up to 256 GB | up to 12 h | **Resumable upload** + async processing; **high quota cost** (~1600 units/upload) |
| **Telegram** | MP4 | ~20 MB by URL / ~50 MB bot upload (2 GB with local Bot API) | — | `sendVideo` (photo=URL or multipart); Telegram fetches/validates |
| **Bluesky** | MP4 | ~100 MB (video service) | ~3 min | `uploadBlob` to the bsky video service + processing job |
| **dev.to / Hashnode** | n/a | n/a | n/a | Embedded URL in markdown only |

**The common thread:** every real video platform is a multi-step async flow (**upload → process → poll → publish**). That shapes the architecture more than codecs do.

---

## 3. Recommended architecture

Mirror the image pipeline's shape, but make video preparation **asynchronous and decoupled from publish**.

```
upload  ──▶  V0 validate (sniff + size/duration/codec ceiling)  ──▶ block early if bad
                       │
approve ──▶  V1 probe + poster (ffprobe + 1 keyframe)  ──▶ metadata.video_probe + video_poster
                       │
            V2 transcode per platform  ──▶ BACKGROUND JOB (external worker / managed)
                       │                     writes provider_derivatives[platform].video
                       ▼
publish ──▶  resolve-provider-video  ──▶ ready(derivative) | pending | blocked
             (CONSUME a prepared derivative; never transcode here)
```

Core principles (carried from the image pipeline):
1. **The original creative is never mutated.** Derivatives + posters are separate storage objects.
2. **The pure decision layer (`prepareProviderMedia`) stays the single source of truth.** Add a `"pending"` status meaning "a derivative is required but not ready yet."
3. **The resolver returns `ready | derivative | pending | blocked`.** Publish-time code only **consumes** a derivative or blocks — no surprise text-only downgrade.
4. **Publishers are the only place that talks to platform video APIs** (V3); each is an isolated multi-step flow.

A new `resolve-provider-video.ts` parallels `resolve-provider-derivative.ts`. Orchestrators dispatch to image-vs-video resolution by `mediaKind`.

---

## 4. Recommended processing model

**Validate at upload → probe + poster at approval → transcode as a background job → consume at publish.**

- **Upload time (V0):** sniff MIME + reject on size/duration/codec against a conservative *universal* ceiling. Fail fast.
- **Approval time (V1):** extract probe metadata + a poster frame (cheap). Surface readiness. A large video does **not** block *approval* (approval is editorial) but drives a per-platform readiness indicator.
- **Background (V2):** transcode per target platform **after approval** (don't spend compute on drafts) in an external worker / managed service. Write `provider_derivatives[platform].video` + status.
- **Publish time:** `resolve-provider-video` returns `ready` (use derivative) / `pending` ("video still preparing — try again shortly", block) / `blocked` (unsupported/oversized/failed). **Never transcode in the publish request.**
- **Manual fallback:** until a platform's V3 lands, keep today's manual-distribution path (operator uploads natively, records the permalink) — explicitly the default for YouTube/IG/Threads.

This eliminates surprise publish-time failures: anything that can fail is decided at upload/approval, and publish only consumes a known-ready artifact.

---

## 5. Recommended dependency strategy

| Need | Recommendation | Rationale |
|---|---|---|
| **Metadata probe (V1)** | `@ffprobe-installer/ffprobe` **or** `ffprobe-static`, invoked via `execFile` with **array args** (no shell, no `fluent-ffmpeg`) | ffprobe is small, read-only, fast. Avoid `fluent-ffmpeg` (extra abstraction + maintenance risk; direct `execFile` is safer and auditable). |
| **Poster frame (V1)** | one `ffmpeg -ss … -frames:v 1` keyframe extract via `execFile` | A single seek + frame is light (~1 s). Can run in a guarded function or the worker. |
| **Transcoding (V2)** | **Do NOT bundle `ffmpeg-static` into Vercel functions.** Choose ONE: **(a) external worker** (Fly.io / Railway / Render container running Node + ffmpeg, fed by a queue), or **(b) managed transcoding** (Mux / Cloudflare Stream / AWS MediaConvert / Coconut / Transloadit). | `ffmpeg-static` (~80 MB) → bundle-limit + cold-start risk alongside `sharp`; transcode time > function timeout. Managed services also handle chunked upload + thumbnails + adaptive output, at the cost of vendor coupling. |
| **Queue / job runner (V2)** | QStash, Inngest, Trigger.dev, or a Supabase table + worker poll | Decouples transcode from the request lifecycle; provides retries + idempotency. |

**Strong recommendation:** ffprobe-only dependencies may enter the repo at **V1**; **no ffmpeg transcoder dependency should ever live in the Vercel function bundle** — V2 runs ffmpeg in an external worker or a managed service.

---

## 6. Recommended metadata shape (no DB migration — extends existing JSONB)

Source-level probe + poster on `creative.metadata` (platform-agnostic):

```jsonc
metadata: {
  video_probe: {
    duration_ms, width, height, container, video_codec, audio_codec,
    bitrate_bps, fps, has_audio, rotation, probed_at
  },
  video_poster: { storage_path, public_url, width, height, generated_at },
  video_preparation: {
    status: "pending" | "ready" | "blocked" | "failed",
    per_platform: { x: "pending" | "ready" | "blocked", instagram: "…" }
  }
}
```

Per-platform derivative under the existing `provider_derivatives` key (parallel to images):

```jsonc
provider_derivatives: {
  x: {
    video: {
      storage_path, public_url, mime_type, size_bytes,
      width, height, duration_ms, container, video_codec, audio_codec,
      bitrate_bps, fps, generated_at, source_size_bytes,
      poster: { storage_path, public_url, width, height },
      transform: {
        output_container, video_codec, audio_codec,
        max_width, max_height, target_bytes, max_duration_ms, crf_or_bitrate
      }
    }
  }
}
```

JSONB is sufficient through V2. A **possible later migration** is a `creative_derivative_jobs` table *only if* queryable async-job state/retries are needed at scale — explicitly out of scope for V0–V1; even V2 can start with JSONB status fields.

---

## 7. Recommended storage path structure (reuse the existing public bucket)

Same `weekly-plan-creatives` bucket, **workspace-id-first** prefix (required by the bucket's RLS — first path segment must be a workspace the user belongs to):

```
{workspaceId}/derivatives/{platform}/{creativeId}/{hash}.{ext}     # transcoded video (V2)
{workspaceId}/posters/{creativeId}/{hash}.jpg                      # poster frame (V1)
{workspaceId}/probes/{creativeId}/{hash}.json                      # optional raw probe (JSONB usually enough)
```

`hash = sha256(original bytes + platform + transform settings)` → deterministic + idempotent + dedup (same as images). Originals are never overwritten.

**Public vs signed URL:** Instagram/Threads *require* a publicly fetchable URL for their container API, so video derivatives must be public-read (the bucket already is). Privacy implication: prepared videos are publicly reachable by URL (mitigated by an unguessable hash). Private delivery would require a bucket-policy change + signed URLs — out of scope; flagged for later.

---

## 8. Security notes

- **Never execute the uploaded file.** Treat all uploaded media as hostile input.
- **MIME sniffing:** validate the real container/codec via ffprobe, not just the declared `Content-Type` / extension.
- **Process isolation:** invoke ffprobe/ffmpeg via `execFile` with **argument arrays** (never a shell string); no user input interpolated into a command line.
- **Restrict ffmpeg/ffprobe inputs:** `-protocol_whitelist file` (no `http`/`tcp`/`concat` tricks), explicit `-f`, input/exec timeouts, and CPU/memory caps in the worker.
- **Hard ceilings before any processing:** size, duration, resolution, and container/codec must pass cheap checks before a transcode is scheduled.
- **Public URL exposure:** prepared videos/posters are public (required by IG/Threads); rely on unguessable hashed paths; revisit signed URLs if privacy is ever required.
- **Resource exhaustion / DoS:** bound concurrent transcodes; reject pathological inputs (huge duration/resolution) early; the queue is the backpressure mechanism.

---

## 9. Runtime risks

- **Serverless timeout/memory** for transcode → must be async/external. *(High; mitigated by the V2 worker.)*
- **Bundle size** (`ffmpeg-static` ~80 MB + `sharp`) → never bundle ffmpeg into Vercel functions. *(High.)*
- **Untrusted-media parsing** → `execFile` + arg arrays, protocol whitelist, timeouts, validate before transcode. *(Security-critical.)*
- **Async correctness** → publish-time `pending` state, idempotent jobs, retries, dedup by hash. *(Medium.)*
- **Per-platform API complexity** → multi-step upload + poll flows, each its own failure surface and quota (e.g. YouTube ~1600 units/upload). *(Medium-high; isolate per platform in V3.)*
- **Public URL exposure** of prepared videos. *(Low-medium; unguessable hash.)*
- **Cost** → transcode compute + storage + egress + managed-service fees. *(A business decision required before V2.)*

---

## 10. Rollout phases

### V0 — Validation only
- Inspect declared metadata; enforce conservative container/codec/duration/size ceilings.
- Block unsupported videos with clear `media_video_*` reasons (no surprise).
- **No transcoding, no new dependencies** (duration may be a conservative byte-based proxy until V1).
- Publish behavior unchanged — video still blocks, just with sharper reasons.

### V1 — Thumbnail + metadata extraction
- ffprobe-derived metadata: duration, width/height, codec/container, fps.
- Poster frame extraction (single keyframe).
- Persist `metadata.video_probe` + `metadata.video_poster`; show readiness in the UI.
- **No transcoding.** ffprobe dependency allowed; poster extraction in a worker or a guarded function.

### V2 — Platform-safe video derivatives
- Transcode / resize / compress per platform in an **external worker / managed service** (async job).
- Write `provider_derivatives[platform].video`; resolver gains a `pending` state.
- **No ffmpeg in the Vercel bundle.**

### V3 — Platform adapter integration
- Wire actual uploads: X chunked, Instagram/Threads container, Telegram `sendVideo`, YouTube resumable (only if intentionally supported, given quota).
- Each is an isolated PR touching that publisher; flip `videoPublishSupported` per platform as it lands.

---

## 11. Future files likely to change (none changed by this document)

**Modify (future):**
- `src/core/publishing/creative-upload-policy.ts` — duration/codec ceilings.
- `src/core/creatives/provider-media-prep.ts` — per-platform video limits, a `pending` status, flip `videoPublishSupported` per phase.
- `src/repositories/weekly-plan-creative-repository.ts` — a probe/poster persist helper.
- `src/app/(app)/weekly-plan/_plan-item-card.tsx` + `src/app/(app)/weekly-plan/page.tsx` — video readiness indicator.

**New (future):**
- `src/core/creatives/video-probe.ts` — ffprobe wrapper.
- `src/core/creatives/video-derivative-transformer.ts` — worker-side transcode.
- `src/core/creatives/resolve-provider-video.ts` — resolver (mirrors `resolve-provider-derivative.ts`).

**V3 only:** the publishers — `src/core/publishing/publish-x.ts` (+ orchestrator), `publish-telegram.ts`, and the Instagram/Threads/YouTube paths that today return `platform_not_supported` in `src/core/publishing/publishing-runner.ts`.

**Infra:** an external worker/queue service (largely out-of-repo); possibly `vercel.json` `maxDuration` only if any video-touching step stays in-function; a *possible* later `creative_derivative_jobs` migration (not V0–V1).

---

## 12. Proposed tests (for when implementation is approved)

- Oversized video blocks **before** any provider call.
- Unsupported codec/container blocks clearly.
- Duration-over-limit blocks clearly.
- Probe metadata extraction is correct.
- Poster-frame extraction produces an image.
- Derivative path is deterministic + dedup-reused.
- **No silent text-only downgrade** (block / `pending` instead).
- `pending` (not-yet-transcoded) blocks publish cleanly.
- **All existing image-derivative tests unchanged.**
- **Non-video publish behavior unchanged** (text + image paths byte-for-byte identical).

---

## 13. Restated warning

**Do not run `ffmpeg` transcoding in the publish request/response path.** The audit proves it is unsafe on Vercel defaults (timeout, memory, bundle size). Transcoding belongs in a background job / external worker; publish-time code may only consume a prepared derivative or block cleanly. Validation (V0) and lightweight probe/poster (V1) are the only video work that may run close to a request — and even those are safer in the worker.
