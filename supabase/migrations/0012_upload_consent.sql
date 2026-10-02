-- Upload consent records. Safe to run more than once.
--
-- One row per uploaded file, written by the server at the moment the signed
-- upload URL is issued. If there is no row, the upload did not happen — the
-- API refuses to mint a URL without consent, so the record and the file are
-- created together or not at all.
--
-- The wording is stored alongside the row rather than referenced by id. Terms
-- get rewritten; a consent record that points at today's wording instead of
-- the wording actually shown is worthless the moment you edit the sentence.
--
-- IP and user agent are kept because a consent record with no way to tie it to
-- a session is an assertion, not evidence. They are named in the privacy
-- policy for exactly this purpose and nothing else.

create table if not exists public.upload_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  storage_path    text not null,
  kind            text not null check (kind in ('image', 'video')),
  consent_version text not null,
  consent_text    text not null,
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now()
);

create index if not exists upload_consents_user_idx
  on public.upload_consents (user_id, created_at desc);

create index if not exists upload_consents_path_idx
  on public.upload_consents (storage_path);

-- RLS on, no policies. Same pattern as `generations` and `credit_ledger`:
-- every write goes through the service-role key, and nothing client-side can
-- read, forge or delete a consent record. A consent log a user can edit is
-- not a consent log.
alter table public.upload_consents enable row level security;

-- Answers "what did this person agree to, and when" for a takedown request.
-- Kept as a function so the lookup is one call rather than a remembered join.
create or replace function public.consent_for_path(p_path text)
returns table (
  user_id uuid,
  email text,
  consent_version text,
  consent_text text,
  ip text,
  user_agent text,
  created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select c.user_id, u.email, c.consent_version, c.consent_text,
         c.ip, c.user_agent, c.created_at
  from public.upload_consents c
  join auth.users u on u.id = c.user_id
  where c.storage_path = p_path
  order by c.created_at desc;
$$;

revoke all on function public.consent_for_path(text)
  from public, anon, authenticated;
grant execute on function public.consent_for_path(text) to service_role;
