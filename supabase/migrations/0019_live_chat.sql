-- Live visitor presence + chat.
-- Paste the whole file into the Supabase SQL editor and Run. Safe to run
-- more than once.
--
-- Three pieces: `visitor_presence` (a heartbeat row per visitor, overwritten
-- on every ping — it's "where are they right now", not a history),
-- `chat_messages` (the actual thread, one row per message, kept forever
-- like `generations`), and `admin_chat_unread_counts()` (same reasoning as
-- `admin_user_overview()` in 0017 — counted in Postgres rather than pulling
-- every message for every online visitor into Next.js just to group them).
--
-- No Supabase Realtime here on purpose. Everything is read through the
-- Next.js server on a short poll — the same pattern this app already uses
-- for generation status and provider balance — so there is nothing new to
-- configure in the Supabase dashboard beyond this file, and no second
-- delivery path (a Realtime channel the browser talks to directly) sitting
-- next to the service-role one every other write in this app already goes
-- through.

-- ---------------------------------------------------------------------------
-- visitor_presence: one row per visitor, overwritten on every heartbeat
-- ---------------------------------------------------------------------------
create table if not exists public.visitor_presence (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Denormalized from auth.users at ping time, so the admin live list is one
  -- table scan rather than a lookup per online visitor against the Admin
  -- Auth API (which has no "get these N users" call, only one-at-a-time or
  -- a full paginated listing).
  email        text,
  is_anonymous boolean not null default false,
  path         text,
  last_seen_at timestamptz not null default now()
);

create index if not exists visitor_presence_last_seen_idx
  on public.visitor_presence (last_seen_at desc);

alter table public.visitor_presence enable row level security;

-- No select/insert/update policy for anon or authenticated, on purpose —
-- same convention as `generations`: the ping endpoint and the admin live
-- list both go through the service-role client, so a visitor's own browser
-- never reads or writes this table directly and can't forge another
-- visitor's presence.

-- ---------------------------------------------------------------------------
-- chat_messages: one row per message, kept (not overwritten)
-- ---------------------------------------------------------------------------
create table if not exists public.chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  sender     text not null check (sender in ('visitor', 'admin')),
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- Set when the *other* side has seen the message — read_at on a 'visitor'
  -- row means admin has read it; read_at on an 'admin' row means the
  -- visitor has. One column does both jobs because a thread only ever has
  -- one other party to read it.
  read_at    timestamptz
);

create index if not exists chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_messages: read own" on public.chat_messages;
create policy "chat_messages: read own"
  on public.chat_messages for select
  using (auth.uid() = user_id);

-- NOTE: no insert/update policy for anon/authenticated — same reasoning as
-- `generations`. Every write, visitor side or admin side, goes through the
-- server with the service-role key, so a visitor can never forge a message
-- that claims to be from 'admin', and can never touch another visitor's
-- thread even for marking it read.

-- ---------------------------------------------------------------------------
-- admin_chat_unread_counts: unread *visitor* messages, grouped by visitor
-- ---------------------------------------------------------------------------
create or replace function public.admin_chat_unread_counts()
returns table (
  user_id      uuid,
  unread_count int
)
language sql stable security definer set search_path = public
as $$
  select user_id, count(*)::int as unread_count
  from public.chat_messages
  where sender = 'visitor' and read_at is null
  group by user_id;
$$;

revoke all on function public.admin_chat_unread_counts() from public, anon, authenticated;
grant execute on function public.admin_chat_unread_counts() to service_role;

-- ---------------------------------------------------------------------------
-- Retention, same shape as purge_old_generations (0013) — a function the
-- operator runs manually or schedules in the Supabase dashboard, not
-- something this migration wires into app code. That function isn't called
-- from anywhere in the Next.js app either; this follows the same precedent
-- rather than being more automated than the retention policy it mirrors.
-- ---------------------------------------------------------------------------
create or replace function public.purge_old_chat(p_months int default 6)
returns bigint
language sql security definer set search_path = public
as $$
  with gone as (
    delete from public.chat_messages
    where created_at < now() - make_interval(months => p_months)
    returning id
  )
  select count(*)::bigint from gone;
$$;

revoke all on function public.purge_old_chat(int) from public, anon, authenticated;
grant execute on function public.purge_old_chat(int) to service_role;
