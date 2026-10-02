-- Start frame / end frame support + a bucket for user-uploaded stills.
-- Safe to run more than once.

alter table public.generations
  add column if not exists end_image_url text;

comment on column public.generations.source_image_url is
  'Start frame. Required for image2video.';
comment on column public.generations.end_image_url is
  'Optional end frame. The model interpolates motion from start to end.';

-- ---------------------------------------------------------------------------
-- uploads bucket
--
-- Public read, because the provider fetches these URLs server-side from its own
-- infrastructure — a signed URL would expire mid-render. Writes go only through
-- /api/upload using the service-role key, so there is no client insert policy.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;

do $$ begin
  drop policy if exists "uploads bucket: public read" on storage.objects;
  create policy "uploads bucket: public read"
    on storage.objects for select
    using (bucket_id = 'uploads');
exception when insufficient_privilege then
  raise notice 'Skipped uploads policy (no ownership of storage.objects) — bucket is public anyway.';
end $$;
