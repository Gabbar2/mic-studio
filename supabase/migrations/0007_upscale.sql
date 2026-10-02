-- Upscaling. Safe to run more than once.
--
-- An upscale is a second provider job against an already-finished clip, so it
-- lives on the same row rather than in its own table: one generation has at
-- most one current upscale, and the gallery needs both URLs side by side.

alter table public.generations
  add column if not exists upscale_status text,
  add column if not exists upscale_task_id text,
  add column if not exists upscale_url text,
  add column if not exists upscale_target text,
  add column if not exists upscale_cost_cents int,
  add column if not exists upscale_error text,
  add column if not exists upscale_completed_at timestamptz;

alter table public.generations
  drop constraint if exists generations_upscale_status_check;
alter table public.generations
  add constraint generations_upscale_status_check
  check (upscale_status is null
         or upscale_status in ('queued', 'processing', 'succeeded', 'failed'));

alter table public.generations
  drop constraint if exists generations_upscale_target_check;
alter table public.generations
  add constraint generations_upscale_target_check
  check (upscale_target is null or upscale_target in ('2k', '4k'));

-- Lets the reconciliation sweep find in-flight upscales without scanning.
create index if not exists generations_upscale_pending_idx
  on public.generations (upscale_task_id)
  where upscale_status in ('queued', 'processing');

-- Upscale spend is tracked separately from generation spend so that
-- spend_summary() keeps meaning "what the clips cost" — the two are different
-- decisions and worth seeing apart.
create or replace function public.upscale_spend_summary(p_user uuid)
returns table (today_cents int, total_cents int)
language sql stable security definer set search_path = public
as $$
  select
    coalesce(sum(upscale_cost_cents) filter (where upscale_completed_at >= date_trunc('day', now())), 0)::int,
    coalesce(sum(upscale_cost_cents), 0)::int
  from public.generations
  where user_id = p_user and upscale_status = 'succeeded';
$$;
