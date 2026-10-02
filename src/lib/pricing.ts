/**
 * Credits — the unit customers see.
 *
 * The ledger stays in cents, because money should be stored as money: it
 * reconciles against Stripe, it survives a change of credit rate, and an
 * auditor can read it. Credits are a presentation layer on top, and nothing
 * below this file knows they exist.
 *
 * Rate: 1000 credits = $1.00. Chosen so a 10-second Standard clip lands just
 * under Leonardo's 1600 credits for the same model, while still costing the
 * customer less per credit than Leonardo charges.
 */

export const CREDITS_PER_CENT = 10;

/** Prices land on a multiple of this, so nobody sees "1512 credits". */
export const CREDIT_ROUNDING = 50;

export function creditsFromCents(cents: number): number {
  return Math.round(cents * CREDITS_PER_CENT);
}

export function centsFromCredits(credits: number): number {
  return Math.round(credits / CREDITS_PER_CENT);
}

/** "1,500" — grouped, because five-figure balances are common. */
export function formatCredits(credits: number): string {
  return credits.toLocaleString("en-US");
}

/** Cents → the credit string shown in the UI. */
export function creditLabel(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return formatCredits(creditsFromCents(cents));
}

/**
 * Rounds a charge so its credit figure is tidy.
 *
 * Applied to the cents value, not just the display, so the ledger and the
 * number on screen can never disagree — a user who adds up their charges must
 * arrive at their balance.
 */
export function roundChargeCents(cents: number): number {
  const credits = cents * CREDITS_PER_CENT;
  const rounded = Math.round(credits / CREDIT_ROUNDING) * CREDIT_ROUNDING;
  return Math.max(centsFromCredits(CREDIT_ROUNDING), centsFromCredits(rounded));
}
