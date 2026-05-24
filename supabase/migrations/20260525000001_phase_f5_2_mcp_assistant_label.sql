-- Phase F5.2 — MCP operator tokens: assistant label + rename support.
--
-- Adds two nullable columns so the founder UI can render
-- assistant-attributable tokens without breaking older rows:
--   * assistant_label — free-form "Claude Code" / "Codex" / "Claude Opus"
--     / "Custom" string the founder selects at creation time.
--   * renamed_at — timestamp the founder last renamed the token (for
--     telemetry / "renamed 2d ago" UI later). NULL on tokens that
--     have never been renamed.
--
-- Neither column changes existing behavior — the name column remains
-- the source of truth for display.

alter table public.mcp_operator_tokens
  add column if not exists assistant_label text;

alter table public.mcp_operator_tokens
  add column if not exists renamed_at timestamptz;

comment on column public.mcp_operator_tokens.assistant_label is
  'Free-form assistant attribution (Claude Code, Codex, Claude Opus, Custom). Nullable. Founder-visible only.';

comment on column public.mcp_operator_tokens.renamed_at is
  'Timestamp the founder last renamed the token. NULL when never renamed.';
