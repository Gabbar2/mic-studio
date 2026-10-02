/**
 * The identity behind the service.
 *
 * A merchant-of-record's review asks sole proprietors to put their legal
 * name in the Terms, and every legal page needs the same details. One file
 * so a change lands everywhere at once and the pages cannot drift apart.
 *
 * >>> KEEP THESE ACCURATE — Polar and any future processor's review both
 * depend on them being correct. <<<
 *
 * The pages render a visible red banner while LEGAL_NAME is still the
 * placeholder, so an unfinished document cannot quietly go live and fail a
 * review for the one reason that was entirely avoidable.
 */

/** Your full legal name, exactly as it appears on the ID Sumsub will see. */
// Annotated as string, not left to infer the literal. Without this TypeScript
// narrows the constant to its own value, decides the comparison below can only
// ever be false, and types the result as `never` — so the guard stops
// compiling the moment it is actually needed.
export const LEGAL_NAME: string = "Sami Baig";

/** Trading name shown to customers. */
export const TRADING_NAME = "Mic Studio";

/**
 * Emirate whose courts hear a dispute. Dubai and Abu Dhabi are the usual
 * choices; name the one you actually reside in.
 */
export const LEGAL_EMIRATE = "Dubai";

export const LEGAL_COUNTRY = "United Arab Emirates";

export const CONTACT_EMAIL = "samibaigmic@gmail.com";

/** Bump when any legal page changes materially. */
export const LEGAL_UPDATED = "3 September 2026";

/** Days a customer has to reclaim unspent credits. */
export const REFUND_WINDOW_DAYS = 14;

export const LEGAL_NAME_PLACEHOLDER = "FULL LEGAL NAME";

export function legalNameIsSet(): boolean {
  return LEGAL_NAME !== LEGAL_NAME_PLACEHOLDER && LEGAL_NAME.trim().length > 2;
}

/** What to print in prose: the legal name, falling back to the trading name. */
export function sellerName(): string {
  return legalNameIsSet() ? LEGAL_NAME : TRADING_NAME;
}
