-- Polar replaces Paddle as the payment processor. Safe to run more than once.
--
-- Same pattern as 0014_paddle.sql: a new column rather than reusing or
-- renaming an old one. The ledger is append-only precisely so that what
-- happened stays legible, and neither stripe_session_id nor
-- paddle_transaction_id ever processed a real payment, so both stay as
-- honest, empty history rather than being repurposed.
--
-- The unique index is the whole idempotency story for the webhook: Polar
-- retries up to 10 times on any non-2xx response, and a duplicate delivery
-- must not grant credit twice. A second insert with the same order id
-- violates the constraint, the route swallows 23505, and the customer is
-- credited exactly once.

alter table public.credit_ledger
  add column if not exists polar_order_id text;

create unique index if not exists credit_ledger_polar_idx
  on public.credit_ledger (polar_order_id)
  where polar_order_id is not null;

comment on column public.credit_ledger.polar_order_id is
  'Polar order id. Unique — the webhook''s idempotency key.';
