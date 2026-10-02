-- Spend reporting. Safe to run more than once.
--
-- Only succeeded generations count. A job that failed at the provider — bad
-- credentials, exhausted balance, rejected prompt — is never billed, so
-- including it would overstate what you actually spent.

create or replace function public.spend_summary(p_user uuid)
returns table (today_cents int, total_cents int)
language sql stable security definer set search_path = public
as $$
  select
    coalesce(
      sum(cost_cents) filter (where created_at >= date_trunc('day', now())), 0
    )::int as today_cents,
    coalesce(sum(cost_cents), 0)::int as total_cents
  from public.generations
  where user_id = p_user
    and status = 'succeeded';
$$;
