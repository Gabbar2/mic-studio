-- Per-user stats for the admin user list. Safe to run more than once.
--
-- Same reasoning as credit_balance()/spend_summary()/generations_today(): one
-- round trip that does the aggregation in Postgres, rather than the Next.js
-- server pulling every row in credit_ledger and every row in generations
-- across every user just to count and sum them in JS. Locked to service_role
-- only, same as those three — see 0011_lock_down_rpc.sql for why that matters
-- once anonymous sign-ins are enabled.

create or replace function public.admin_user_overview()
returns table (
  user_id      uuid,
  clips        int,
  credits_left int
)
language sql stable security definer set search_path = public
as $$
  select
    p.id as user_id,
    coalesce((
      select count(*)::int from public.generations g
      where g.user_id = p.id and g.status = 'succeeded'
    ), 0) as clips,
    coalesce((
      select sum(l.amount_cents)::int from public.credit_ledger l
      where l.user_id = p.id
    ), 0) as credits_left
  from public.profiles p;
$$;

revoke all on function public.admin_user_overview() from public, anon, authenticated;
grant execute on function public.admin_user_overview() to service_role;
