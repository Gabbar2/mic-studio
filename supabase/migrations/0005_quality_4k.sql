-- Allow the 4K quality tier. Safe to run more than once.

alter table public.generations drop constraint if exists generations_quality_check;
alter table public.generations
  add constraint generations_quality_check
  check (quality in ('std', 'pro', '4k'));
