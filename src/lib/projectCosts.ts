/**
 * What this project costs to run, as shown in the header popover.
 *
 * These are your figures, not something the app measures — edit them here when
 * your plan or budget changes. Values are in CENTS to match the rest of the
 * money handling in the app (see lib/format.ts).
 */

export interface CostLine {
  label: string;
  cents: number;
  /** Billing page for this line. Opens in a new tab. */
  href: string;
  /** Monthly subscriptions are re-paid if the project runs past 30 days. */
  recurring?: boolean;
  note?: string;
}

export const PROJECT_COST_LINES: CostLine[] = [
  {
    label: "fal generation",
    cents: 10000,
    href: "https://fal.ai/dashboard/billing",
    note: "one-time",
  },
  {
    label: "Vercel Pro",
    cents: 2000,
    // Swap the team slug if you move the project to another Vercel team.
    href: "https://vercel.com/deliverybykea-1349s-projects/~/settings/billing",
    recurring: true,
    note: "per month",
  },
  {
    label: "Supabase Pro",
    cents: 2500,
    // The `_` resolves to an org picker, so this works whatever your org id is.
    href: "https://supabase.com/dashboard/org/_/billing",
    recurring: true,
    note: "per month",
  },
];

export function projectCostTotalCents(): number {
  return PROJECT_COST_LINES.reduce((sum, line) => sum + line.cents, 0);
}

/** The part that repeats every month, called out separately in the popover. */
export function projectCostRecurringCents(): number {
  return PROJECT_COST_LINES.filter((l) => l.recurring).reduce(
    (sum, line) => sum + line.cents,
    0,
  );
}
