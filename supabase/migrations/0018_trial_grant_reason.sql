-- Splits the anonymous trial's one-time credit from the real signup welcome
-- grant, which until now shared the same 'signup_grant' reason and were only
-- told apart by a free-text `note`. That made ensureSignupGrant()'s "has this
-- user ever had a ledger row" guard unable to tell "already got the real
-- welcome bonus" apart from "only ever got the anonymous trial clip" — so an
-- anonymous visitor who tried the app, then signed up for a real account
-- (Supabase keeps the same user id across that conversion), never received
-- the signup grant at all. See src/lib/credits.ts for the corrected guard.

alter table public.credit_ledger
  drop constraint credit_ledger_reason_check;

alter table public.credit_ledger
  add constraint credit_ledger_reason_check
  check (reason in (
    'signup_grant',
    'trial_grant',
    'purchase',
    'subscription',
    'generation',
    'upscale',
    'refund',
    'adjustment'
  ));
