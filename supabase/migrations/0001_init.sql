-- Kling Studio — initial schema
-- Paste the whole file into the Supabase SQL editor and Run.
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, created automatically on signup
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  -- free-tier throttle. Not money — just abuse control until billing lands.
  daily_quota  int  not null default 5,
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- auto-provision a profile whenever a user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- generations: one row per video job
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.generation_status as enum ('queued', 'processing', 'succeeded', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.generations (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,

  -- what the user asked for
  mode             text not null default 'text2video'
                   check (mode in ('text2video', 'image2video')),
  model_id         text not null,
  prompt           text not null,
  negative_prompt  text,
  aspect_ratio     text not null default '16:9',
  duration_seconds int  not null default 5,
  quality          text not null default 'std' check (quality in ('std', 'pro')),
  cfg_scale        numeric(3,2) not null default 0.5,
  with_audio       boolean not null default false,
  source_image_url text,

  -- provider bookkeeping. provider is stored so a second model is a row value,
  -- not a schema migration.
  provider         text not null default 'kling',
  provider_task_id text,
  status           public.generation_status not null default 'queued',
  error_message    text,

  -- results
  video_url        text,   -- provider CDN url (expires — see storage_path)
  thumbnail_url    text,
  storage_path     text,   -- our own copy in Supabase Storage
  duration_actual  numeric(5,2),

  -- cost tracking in USD cents, filled from the model's price table
  cost_cents       int,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index if not exists generations_user_created_idx
  on public.generations (user_id, created_at desc);
create index if not exists generations_status_idx
  on public.generations (status)
  where status in ('queued', 'processing');
create unique index if not exists generations_provider_task_idx
  on public.generations (provider, provider_task_id)
  where provider_task_id is not null;

alter table public.generations enable row level security;

drop policy if exists "generations: read own" on public.generations;
create policy "generations: read own"
  on public.generations for select
  using (auth.uid() = user_id);

drop policy if exists "generations: delete own" on public.generations;
create policy "generations: delete own"
  on public.generations for delete
  using (auth.uid() = user_id);

-- NOTE: no insert/update policy for the anon/authed role on purpose.
-- All writes go through the server using the service-role key, so a user
-- can never fabricate a row that claims a job they did not pay for.

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists generations_touch on public.generations;
create trigger generations_touch
  before update on public.generations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- daily usage counter, used to enforce profiles.daily_quota
-- ---------------------------------------------------------------------------
create or replace function public.generations_today(p_user uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int
  from public.generations
  where user_id = p_user
    and created_at >= date_trunc('day', now())
    and status <> 'failed';
$$;

-- ---------------------------------------------------------------------------
-- Storage bucket for our own copies of finished videos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('generations', 'generations', true)
on conflict (id) do nothing;

-- The bucket is already public, so this policy is belt-and-braces. Some
-- projects don't grant the SQL editor ownership of storage.objects, so a
-- failure here is swallowed rather than aborting the whole migration.
do $$ begin
  drop policy if exists "generations bucket: public read" on storage.objects;
  create policy "generations bucket: public read"
    on storage.objects for select
    using (bucket_id = 'generations');
exception when insufficient_privilege then
  raise notice 'Skipped storage policy (no ownership of storage.objects) — bucket is public anyway.';
end $$;
