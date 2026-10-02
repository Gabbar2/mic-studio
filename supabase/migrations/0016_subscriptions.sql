-- Monthly/yearly subscriptions, on top of the existing credit ledger. Safe to
-- run more than once.
--
-- A subscription grants credit exactly the same way a pack does — a row in
-- credit_ledger, same balance, same spend path. This migration only adds
-- what a pack purchase never needed: somewhere to remember which plan a user
-- is on, so the app can show "renews Oct 15" and hand them a way to cancel,
-- and so a renewal order that arrives without fresh checkout metadata can
-- still be attributed to the right user (see the webhook's fallback lookup).

alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('signup_grant', 'purchase', 'subscription', 'generation', 'upscale', 'refund', 'adjustment'));

-- id is Polar's own subscription id, not a bigserial — the webhook upserts by
-- it directly, and a subscription only ever has one row (unlike the ledger,
-- which is append-only because every event needs its own line item).
create table if not exists public.subscriptions (
  id                    text primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  plan_id               text check (plan_id in ('sub_monthly', 'sub_yearly')),
  status                text not null,
  polar_customer_id     text,
  current_period_end    timestamptz,
  cancel_at_period_end  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);

-- One active-ish row worth showing per user in the common case, but a user
-- who cancels and later resubscribes gets a second row (a new Polar
-- subscription id) rather than a reused one — both are useful history, and
-- the app reads "the most recent by created_at" rather than assuming there's
-- only ever one.

alter table public.subscriptions enable row level security;

drop policy if exists "subscriptions: read own" on public.subscriptions;
create policy "subscriptions: read own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- No insert/update policy on purpose, same as credit_ledger — every write
-- goes through the webhook, which uses the service-role key.
