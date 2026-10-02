-- Credit ledger. Safe to run more than once.
--
-- Append-only by design: rows are never updated or deleted, and the balance is
-- always the sum. That means every charge, refund and top-up stays auditable,
-- and a bug can be corrected with a compensating row rather than by rewriting
-- history you can no longer verify.

create table if not exists public.credit_ledger (
  id                bigserial primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  -- positive = credit granted, negative = spent
  amount_cents      int not null,
  reason            text not null
                    check (reason in ('signup_grant', 'purchase', 'generation', 'refund', 'adjustment')),
  generation_id     uuid references public.generations(id) on delete set null,
  stripe_session_id text,
  note              text,
  created_at        timestamptz not null default now()
);

create index if not exists credit_ledger_user_idx
  on public.credit_ledger (user_id, created_at desc);

-- One charge per generation, and one credit per Stripe session. These indexes
-- are what make a duplicated webhook or a double-submit harmless.
create unique index if not exists credit_ledger_generation_charge_idx
  on public.credit_ledger (generation_id)
  where reason = 'generation';

create unique index if not exists credit_ledger_stripe_idx
  on public.credit_ledger (stripe_session_id)
  where stripe_session_id is not null;

alter table public.credit_ledger enable row level security;

drop policy if exists "ledger: read own" on public.credit_ledger;
create policy "ledger: read own"
  on public.credit_ledger for select
  using (auth.uid() = user_id);

-- No insert/update policy on purpose. Every write goes through the server.

-- What the user was actually charged, which is not the same as what the
-- provider charged us — see PRICE_MARKUP.
alter table public.generations
  add column if not exists charged_cents int;

-- ---------------------------------------------------------------------------
create or replace function public.credit_balance(p_user uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(amount_cents), 0)::int
  from public.credit_ledger
  where user_id = p_user;
$$;

/**
 * Debit atomically, or refuse.
 *
 * The advisory lock serialises concurrent generations for one user, so two
 * requests arriving together cannot both read a sufficient balance and both
 * spend it. Without it, a double-click is a free generation.
 */
create or replace function public.try_debit(
  p_user       uuid,
  p_amount     int,
  p_generation uuid
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  bal int;
begin
  if p_amount <= 0 then
    return true;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select coalesce(sum(amount_cents), 0) into bal
  from public.credit_ledger
  where user_id = p_user;

  if bal < p_amount then
    return false;
  end if;

  insert into public.credit_ledger (user_id, amount_cents, reason, generation_id)
  values (p_user, -p_amount, 'generation', p_generation);

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Credits are now the real spending limit. daily_quota stays as a burst guard
-- only — it stops a runaway loop, it is not the budget.
alter table public.profiles alter column daily_quota set default 20;
