-- Charge for upscales. Safe to run more than once.
--
-- Until now an upscale recorded what it cost us but never took anything from
-- the customer — free 2K masters, billed to you.

alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in ('signup_grant', 'purchase', 'generation', 'upscale', 'refund', 'adjustment'));

-- An upscale is a second chargeable event on the same generation, so it needs
-- its own uniqueness guard rather than sharing the generation one.
create unique index if not exists credit_ledger_upscale_charge_idx
  on public.credit_ledger (generation_id)
  where reason = 'upscale';

alter table public.generations
  add column if not exists upscale_charged_cents int;

/**
 * Same atomic debit as try_debit, with the reason as a parameter.
 *
 * Separate function rather than a changed signature, so the existing
 * three-argument call sites keep working untouched.
 */
create or replace function public.try_debit_reason(
  p_user       uuid,
  p_amount     int,
  p_generation uuid,
  p_reason     text
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
  values (p_user, -p_amount, p_reason, p_generation);

  return true;
end;
$$;
