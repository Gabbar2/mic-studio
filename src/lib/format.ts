/** Cents → "$1.68". Sub-cent values round up so nothing shows as free. */
export function usd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  if (cents > 0 && cents < 1) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

export interface Spend {
  todayCents: number;
  totalCents: number;
}
