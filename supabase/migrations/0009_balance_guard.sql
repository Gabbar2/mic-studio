-- Balance guard. Safe to run more than once.
--
-- Two problems this solves, both of which only show up once real customers
-- exist:
--
--   1. The fal balance is prepaid and topped up by hand. Nothing in the app
--      knew what it was between page loads, so a generation could be accepted
--      against a balance that had already run out.
--   2. Sold credits are a liability — service owed but not yet delivered — and
--      there was no way to ask how much of it was outstanding.

-- ---------------------------------------------------------------------------
-- app_state: a tiny key/value store for operational facts that belong to the
-- installation rather than to any user.
--
-- Deliberately not a settings table. Everything in here is written by the
-- server and read by the server; it is a cache and a latch, not configuration.
-- ---------------------------------------------------------------------------

create table if not exists public.app_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- No policies, and RLS on. Only the service role touches this table, so the
-- absence of a policy is the access rule: nothing reachable from the browser
-- can read or write it.
alter table public.app_state enable row level security;

-- ---------------------------------------------------------------------------
-- credit_liability(): every credit sold or granted and not yet spent.
--
-- The ledger is append-only, so this is simply the sum of every row: grants and
-- purchases are positive, generations and upscales negative, refunds positive
-- again. What comes back is what the app still owes its customers in service.
--
-- Divide by the price markup to get the fal cost that liability represents —
-- that conversion lives in the application, because the markup does.
-- ---------------------------------------------------------------------------

create or replace function public.credit_liability()
returns bigint
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(amount_cents), 0)::bigint from public.credit_ledger;
$$;

revoke all on function public.credit_liability() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seeded so the first read never has to special-case a missing row. A null
-- balance means "not measured yet", which the guard treats as "allow" — a
-- monitoring gap must never become an outage.
-- ---------------------------------------------------------------------------

insert into public.app_state (key, value)
values ('provider_balance', '{"cents": null, "checked_at": null}'::jsonb)
on conflict (key) do nothing;

insert into public.app_state (key, value)
values ('low_balance_alert', '{"sent_at": null}'::jsonb)
on conflict (key) do nothing;
