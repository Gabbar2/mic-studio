-- Six-month retention. Safe to run more than once.
--
-- The privacy policy now states that clips are deleted after six months. That
-- sentence is the reason this file exists: a retention period nobody enforces
-- is not a policy, it is a false statement in a legal document, and it is
-- worse than having said nothing at all. GDPR's storage-limitation principle
-- is satisfied by deleting, not by promising to.
--
-- What goes:
--   - the generation row: prompt, settings, cost, provider ids
--   - the consent records for files that fed it
--
-- What stays:
--   - the credit ledger, because it is the audit trail behind a balance
--     someone may still hold, and a ledger with holes cannot be reconciled
--   - the account itself, which lives until the person asks for it to go
--
-- The function returns the storage paths it orphaned rather than trying to
-- delete the files itself. Removing a row from storage.objects does not
-- reliably remove the underlying object, so the files have to go through the
-- storage API — see the note in the runbook.

create or replace function public.purge_old_generations(p_months int default 6)
returns table (deleted_id uuid, orphaned_path text)
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with gone as (
    delete from public.generations g
    where g.created_at < now() - make_interval(months => p_months)
    returning g.id, g.storage_path
  ),
  -- Consent records are evidence about a file. Once the generation and its
  -- upload are gone there is nothing left for them to be evidence of, and
  -- keeping an IP address longer than the thing it justified would contradict
  -- the policy that collected it.
  consents as (
    delete from public.upload_consents c
    where c.created_at < now() - make_interval(months => p_months)
      and not exists (
        select 1 from public.generations g
        where g.source_image_url like '%' || c.storage_path
           or g.end_image_url like '%' || c.storage_path
           or g.reference_video_url like '%' || c.storage_path
      )
    returning 1
  )
  select gone.id, gone.storage_path
  from gone
  -- Forces the consent CTE to run. Without a reference Postgres is free to
  -- skip it entirely, and the deletion above would silently never happen.
  where (select count(*) from consents) >= 0;
end;
$$;

revoke all on function public.purge_old_generations(int)
  from public, anon, authenticated;
grant execute on function public.purge_old_generations(int) to service_role;

-- How many clips are already past the line. Run this before the first purge:
-- if it returns thousands, delete in batches rather than in one transaction.
create or replace function public.retention_due(p_months int default 6)
returns bigint
language sql stable security definer set search_path = public
as $$
  select count(*)::bigint
  from public.generations
  where created_at < now() - make_interval(months => p_months);
$$;

revoke all on function public.retention_due(int)
  from public, anon, authenticated;
grant execute on function public.retention_due(int) to service_role;
