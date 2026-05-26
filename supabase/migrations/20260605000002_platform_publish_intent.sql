-- Phase F6.0 — platform-native publishing intent.
--
-- Adds a nullable JSONB column on weekly_plan_items that carries the
-- operator's explicit platform-native shape choice:
--
--   {
--     "version": 1,
--     "platform": "bluesky",
--     "intent": "new_post" | "thread" | "reply" | "comment"
--               | "quote" | "repost" | "article" | "media_post"
--               | "link_post" | "video_post" | "carousel" | "story"
--               | "short_video" | "unknown",
--     "threadMode": "none" | "single_only" | "auto_thread_allowed"
--                   | "manual_thread" | "platform_default",
--     "mediaMode": "none" | "first_part_only" | "every_part"
--                  | "platform_default" | "media_required",
--     "expectedPartCount": <integer | null>,
--     "replyTarget": {"externalId": "...", "url": "..."} | null,
--     "quoteTarget":  {"externalId": "...", "url": "..."} | null,
--     "operatorApprovedShapeHash": "sha256:..." | null
--   }
--
-- Persistence rules
-- -----------------
--   - nullable: existing rows keep NULL → treated as "legacy payload
--     mode" by the platform-native adapters. No backfill. No default.
--   - no CHECK: shape validation lives in the TypeScript adapter layer
--     (src/core/platform-native/) so each platform owns its own
--     vocabulary. DB stays neutral.
--   - no index: query patterns aren't established yet. Add later when
--     warranted.
--
-- Rollback
-- --------
--   alter table public.weekly_plan_items
--     drop column platform_publish_intent;
--
-- No FKs, no triggers, no views, no RLS rule depends on this column;
-- dropping is safe.

set search_path = public;

alter table public.weekly_plan_items
  add column if not exists platform_publish_intent jsonb;
