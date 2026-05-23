-- Phase F2.5 — Supabase Storage bucket + creative upload metadata.

-- 1. Bucket: public-read, workspace-write, MIME-whitelisted.
--    Path convention: workspace_id/<weekly_plan_item_id>/<random>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'weekly-plan-creatives',
  'weekly-plan-creatives',
  true,
  104857600,  -- 100 MB hard cap at the storage layer
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. Storage policies. READ is public (no policy needed beyond the
--    bucket flag). Mutations require authenticated workspace
--    membership against the FIRST path segment (workspace_id).
drop policy if exists "weekly_plan_creatives: members can upload"
  on storage.objects;
create policy "weekly_plan_creatives: members can upload"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'weekly-plan-creatives'
    and (storage.foldername(name))[1] is not null
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "weekly_plan_creatives: members can update"
  on storage.objects;
create policy "weekly_plan_creatives: members can update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'weekly-plan-creatives'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "weekly_plan_creatives: members can delete"
  on storage.objects;
create policy "weekly_plan_creatives: members can delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'weekly-plan-creatives'
    and public.is_workspace_member(((storage.foldername(name))[1])::uuid)
  );

-- 3. Per-upload metadata on weekly_plan_item_creatives.
alter table public.weekly_plan_item_creatives
  add column if not exists storage_path text,
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint,
  add column if not exists uploaded_by uuid references auth.users(id) on delete set null,
  add column if not exists uploaded_at timestamptz;

-- Defence in depth: even rows attached via MCP cannot land with a
-- bogus mime_type. NULL is allowed for URL-only attachments.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'creatives_mime_whitelist'
  ) then
    alter table public.weekly_plan_item_creatives
      add constraint creatives_mime_whitelist
      check (
        mime_type is null
        or mime_type in (
          'image/jpeg', 'image/png', 'image/webp', 'image/gif',
          'video/mp4', 'video/webm'
        )
      );
  end if;
end $$;

create index if not exists weekly_plan_item_creatives_uploaded_by_idx
  on public.weekly_plan_item_creatives (uploaded_by, uploaded_at desc);
