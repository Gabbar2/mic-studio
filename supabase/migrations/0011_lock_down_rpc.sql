-- Lock down the security-definer functions. Safe to run more than once.
--
-- WHY THIS EXISTS
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Supabase
-- exposes every function in the `public` schema over PostgREST as an RPC
-- endpoint. Put those two together and every function written before 0009 has
-- been callable by anyone holding an `authenticated` JWT since the day it
-- shipped.
--
-- They are all `security definer`, so they run as their owner and RLS does not
-- apply inside them. And they all take the user id as a *parameter* rather
-- than reading auth.uid(), because they were written to be called by the
-- server with the service-role key — which is correct, and is exactly what
-- makes them dangerous when anyone else can reach them.
--
-- The worst of them is try_debit. It is not a read:
--
--   select try_debit('<someone else>', 50000, null);
--
-- That writes a negative row into their ledger. An attacker cannot mint
-- credits with it — a non-positive amount returns early without inserting —
-- but they can zero out a paying customer's balance, and repeat it every time
-- that customer tops up. credit_balance() hands them the exact figure to pass.
--
-- Enabling anonymous sign-ins is what turns this from a flaw into an open
-- door. It used to take a working email address and a magic-link click to get
-- an `authenticated` token. It now takes one unauthenticated API call, free,
-- from anywhere, as many times as you like.
--
-- The last piece is the victim's user id, and it was not secret either:
-- uploads are stored at `uploads/<user_id>/<uuid>.<ext>` in a bucket whose
-- select policy is `using (bucket_id = 'uploads')`. Any authenticated user
-- could list that bucket and read off every user id that has ever uploaded a
-- reference image. See the note at the bottom.
--
-- WHAT THIS CHANGES FOR THE APP
--
-- Nothing. Every call site was checked: all eight of them use the admin client
-- (`src/lib/credits.ts`, `src/lib/anon.ts`, `src/lib/appState.ts`,
-- `src/app/api/generate`, `src/app/api/generations`, `src/app/studio/page`).
-- The browser never calls an RPC. The grant to service_role below is what the
-- server runs on, and it is granted explicitly rather than left to inherit
-- from PUBLIC — which is the whole point of revoking PUBLIC.

-- --------------------------------------------------------------------------
-- Money. This is the one that could be used destructively.
-- --------------------------------------------------------------------------

revoke all on function public.try_debit(uuid, int, uuid)
  from public, anon, authenticated;
grant execute on function public.try_debit(uuid, int, uuid)
  to service_role;

revoke all on function public.try_debit_reason(uuid, int, uuid, text)
  from public, anon, authenticated;
grant execute on function public.try_debit_reason(uuid, int, uuid, text)
  to service_role;

-- --------------------------------------------------------------------------
-- Reads. Each one answers a question about an arbitrary user id, which is a
-- leak rather than a loss — but a leak that told the attacker above exactly
-- how much to take.
-- --------------------------------------------------------------------------

revoke all on function public.credit_balance(uuid)
  from public, anon, authenticated;
grant execute on function public.credit_balance(uuid) to service_role;

revoke all on function public.spend_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.spend_summary(uuid) to service_role;

revoke all on function public.generations_today(uuid)
  from public, anon, authenticated;
grant execute on function public.generations_today(uuid) to service_role;

revoke all on function public.upscale_spend_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.upscale_spend_summary(uuid) to service_role;

-- --------------------------------------------------------------------------
-- Already revoked in 0009 and 0010. Repeated here so this file is the single
-- place that answers "who can call what", and the explicit service_role grant
-- is added to match.
-- --------------------------------------------------------------------------

revoke all on function public.credit_liability()
  from public, anon, authenticated;
grant execute on function public.credit_liability() to service_role;

revoke all on function public.anon_spend_today()
  from public, anon, authenticated;
grant execute on function public.anon_spend_today() to service_role;

revoke all on function public.purge_stale_anonymous(int)
  from public, anon, authenticated;
grant execute on function public.purge_stale_anonymous(int) to service_role;

-- --------------------------------------------------------------------------
-- Stop new functions from repeating this.
--
-- The default privilege is what created the problem: every `create function`
-- silently handed EXECUTE to PUBLIC. This removes that default for the roles
-- that reach PostgREST, so a function added next month is private unless it is
-- granted out on purpose.
--
-- It applies only to functions created by the role running this statement,
-- which in the SQL editor is `postgres` — the same role the editor uses for
-- every later migration. Functions created by other roles are unaffected,
-- hence the explicit revokes above rather than relying on this alone.
-- --------------------------------------------------------------------------

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- --------------------------------------------------------------------------
-- NOT DONE HERE: the storage listing.
--
-- `uploads` and `generations` both carry a select policy of the form
-- `using (bucket_id = '...')`, which lets any authenticated user enumerate
-- every object — and the paths contain user ids.
--
-- Narrowing it to the owner's own folder would look like this:
--
--   create policy "uploads bucket: read own folder"
--     on storage.objects for select
--     using (
--       bucket_id = 'uploads'
--       and (storage.foldername(name))[1] = auth.uid()::text
--     );
--
-- It is left out deliberately. Both buckets are `public: true`, and a public
-- bucket serves its files through a path that does not consult RLS at all, so
-- in principle this narrows listing without touching playback. In principle.
-- Every <img> and <video> in the app, plus the URLs handed to fal, resolve
-- through that public path, and getting this wrong means every thumbnail and
-- every clip in the gallery goes blank.
--
-- With the functions above locked, a harvested user id buys an attacker
-- nothing — there is no longer anything to do with one. So this is worth
-- doing, and worth doing on its own, against a preview project, where a
-- mistake costs a redeploy instead of an outage.
-- --------------------------------------------------------------------------
