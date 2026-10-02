-- Anonymous trial. Safe to run more than once.
--
-- Visitors can generate one clip before signing in. Supabase's anonymous
-- sign-in gives them a real auth.users row with is_anonymous = true, so
-- everything downstream — the ledger, RLS, generations — works unchanged, and
-- linking an email later keeps the same id so their clip survives the sign-up.
--
-- The risk this file addresses is the one identification cannot: a cookie is
-- cleared in a second, an IP is shared by a whole mobile network, and a
-- fingerprint loses to a second browser. None of them bound the loss.
-- A total daily spend does, exactly, regardless of how many identities one
-- person creates.

create or replace function public.anon_spend_today()
returns bigint
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(g.cost_cents), 0)::bigint
  from public.generations g
  join auth.users u on u.id = g.user_id
  where u.is_anonymous = true
    -- Provider cost, not the customer charge: this budget protects the fal
    -- balance, and a trial clip is never actually paid for.
    and g.created_at >= date_trunc('day', now() at time zone 'utc')
    -- Failed jobs are refunded and cost nothing, so they must not count
    -- against the day's allowance.
    and g.status <> 'failed';
$$;

revoke all on function public.anon_spend_today() from public, anon, authenticated;

-- Anonymous users are throwaway by nature: cleared cookies, a new browser, a
-- different device all strand one. Without this the table grows forever with
-- rows nobody can ever sign back into.
--
-- Deliberately not scheduled here. Run it by hand, or wire it to the cron once
-- you have enough traffic for it to matter.
create or replace function public.purge_stale_anonymous(p_days int default 30)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  removed int;
begin
  with gone as (
    delete from auth.users u
    where u.is_anonymous = true
      and u.created_at < now() - make_interval(days => p_days)
      -- Never remove one that produced something. A stranded clip is still
      -- evidence of what the trial did, and the row is tiny.
      and not exists (
        select 1 from public.generations g where g.user_id = u.id
      )
    returning 1
  )
  select count(*) into removed from gone;
  return removed;
end;
$$;

revoke all on function public.purge_stale_anonymous(int) from public, anon, authenticated;
