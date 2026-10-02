import { createAdminClient } from "./supabase/admin";
import { roundChargeCents } from "./pricing";
import { anonGrantCents } from "./anon";
import { fireResendEvent } from "./events";

/**
 * Credits, in USD cents.
 *
 * Two different numbers travel together and must not be confused:
 *   - provider cost  — what fal charges us, stored on generations.cost_cents
 *   - charged        — what the user pays, stored on generations.charged_cents
 *
 * The gap between them is PRICE_MARKUP, and it is the entire business model.
 */

/** Multiplier applied to provider cost to get the user-facing price. */
export function priceMarkup(): number {
  const raw = Number(process.env.PRICE_MARKUP ?? 1.8);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.8;
}

/**
 * One-off credit granted the first time a real (non-anonymous) account opens
 * the studio. 225 cents = 2,250 credits, exactly one 10-second Standard clip
 * WITH audio — enough to try the free-tier's best clip once before landing on
 * the credit floor.
 */
export function signupGrantCents(): number {
  const raw = Number(process.env.SIGNUP_GRANT_CENTS ?? 225);
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 225;
}

/**
 * True for a subscriber (any subscription row, whatever its current status —
 * even a lapsed one paid for real access at some point) or anyone who has ever
 * bought a one-time credit pack. Either one is what separates a free, capped
 * account from a fully unlocked one — see lib/freeTier.ts for what stays
 * capped until then.
 *
 * Deliberately not "currently active subscription only": a canceled
 * subscriber who already paid should not be relocked into the free tier's
 * hard caps, only back onto the same credit floor everyone eventually hits.
 */
export async function isUnlockedAccount(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const [{ count: purchaseCount }, { count: subCount }] = await Promise.all([
    admin
      .from("credit_ledger")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .in("reason", ["purchase", "subscription"]),
    admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);
  return (purchaseCount ?? 0) > 0 || (subCount ?? 0) > 0;
}

/**
 * Same test as `isUnlockedAccount`, batched across many users in two queries
 * total instead of two queries per user. Built for the live visitor list,
 * where N+1 would mean a growing number of round trips on every poll as
 * more people are online at once, rather than for a single account page
 * where the per-user version already reads fine.
 */
export async function bulkUnlockedUserIds(
  userIds: string[],
): Promise<Set<string>> {
  if (!userIds.length) return new Set();

  const admin = createAdminClient();
  const [{ data: purchases }, { data: subs }] = await Promise.all([
    admin
      .from("credit_ledger")
      .select("user_id")
      .in("user_id", userIds)
      .in("reason", ["purchase", "subscription"]),
    admin.from("subscriptions").select("user_id").in("user_id", userIds),
  ]);

  const unlocked = new Set<string>();
  for (const row of (purchases ?? []) as { user_id: string }[]) {
    unlocked.add(row.user_id);
  }
  for (const row of (subs ?? []) as { user_id: string }[]) {
    unlocked.add(row.user_id);
  }
  return unlocked;
}

/**
 * `markup` defaults to the global PRICE_MARKUP env var, same as before this
 * parameter existed. A caller that knows which model it's pricing should pass
 * `effectiveMarkup(model, priceMarkup())` instead, so a model with its own
 * `priceMarkupOverride` (see lib/models.ts) is charged on its own curve
 * rather than the operator's blanket rate.
 */
export function chargeForProviderCost(
  providerCents: number,
  markup: number = priceMarkup(),
): number {
  return roundChargeCents(providerCents * markup);
}

export async function creditBalance(userId: string): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("credit_balance", { p_user: userId });
  return typeof data === "number" ? data : 0;
}

/**
 * Gives the one-time signup grant if this user has never received *this
 * specific* grant before.
 *
 * Done lazily on first read rather than in the signup trigger, so the amount
 * stays an environment variable rather than something baked into a migration.
 *
 * The trial grant (anonymous) and the welcome grant (real signup) are
 * tracked as distinct ledger reasons — `trial_grant` vs `signup_grant` — and
 * the guard below only checks for the one this call is about to give.
 * Checking "any ledger row at all" used to be the bug here: because
 * converting an anonymous session into a real account keeps the same user
 * id, a visitor who spent their one free trial clip *before* signing up
 * would already have a ledger row by the time they signed up, and the old
 * guard would then skip the real signup grant forever, leaving a genuine
 * paying-intent user stuck with trial-sized credit permanently.
 */
export async function ensureSignupGrant(
  userId: string,
  isAnonymous = false,
  contact?: { email: string; firstName?: string },
): Promise<void> {
  const grant = isAnonymous ? anonGrantCents() : signupGrantCents();
  if (grant <= 0) return;

  const reason = isAnonymous ? "trial_grant" : "signup_grant";

  const admin = createAdminClient();
  const { count } = await admin
    .from("credit_ledger")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("reason", reason);

  if ((count ?? 0) > 0) return;

  await admin.from("credit_ledger").insert({
    user_id: userId,
    amount_cents: grant,
    reason,
    note: isAnonymous ? "Free trial clip" : "Welcome credit",
  });

  // Fire-and-forget: the "first_login" Resend Automation sends the welcome
  // email. Only for real accounts with a real email — an anonymous trial
  // visitor has neither yet, and the reason-scoped guard above already
  // guarantees this is the one time this user's *signup_grant* is created,
  // even if they picked up a trial_grant earlier as an anonymous visitor.
  if (!isAnonymous && contact?.email) {
    void fireResendEvent("first_login", contact.email, {
      first_name: contact.firstName ?? contact.email.split("@")[0],
    });
  }
}

/** Returns false when the balance is insufficient. Never throws on refusal. */
export async function tryDebit(
  userId: string,
  amountCents: number,
  generationId: string,
  reason: "generation" | "upscale" = "generation",
): Promise<boolean> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("try_debit_reason", {
    p_user: userId,
    p_amount: amountCents,
    p_generation: generationId,
    p_reason: reason,
  });

  if (error) {
    console.error("[credits] debit failed", error);
    return false;
  }
  return data === true;
}

/**
 * Puts money back after a failed generation.
 *
 * The provider does not bill for failures, so neither do we. Written as a
 * compensating entry rather than by deleting the charge — the ledger is the
 * audit trail, and a disappearing charge is indistinguishable from a bug.
 */
export async function refundGeneration(
  userId: string,
  generationId: string,
  amountCents: number,
  note: string,
): Promise<void> {
  if (amountCents <= 0) return;

  const admin = createAdminClient();
  const { error } = await admin.from("credit_ledger").insert({
    user_id: userId,
    amount_cents: amountCents,
    reason: "refund",
    generation_id: generationId,
    note: note.slice(0, 200),
  });

  if (error) console.error("[credits] refund failed", error);
}

/**
 * Top-up packs.
 *
 * `priceCents` is what Stripe charges; `creditCents` is what lands in the
 * ledger. Bigger packs credit more than they cost — the bonus is the reason to
 * buy the bigger one, and it improves your margin per Stripe fee at the same
 * time (one 30c fixed fee spread over $50 instead of $10).
 */
export const CREDIT_PACKS = [
  { id: "pack_10", priceCents: 1000, creditCents: 1000, label: "$10" },
  { id: "pack_25", priceCents: 2500, creditCents: 2750, label: "$25" },
  { id: "pack_50", priceCents: 5000, creditCents: 6000, label: "$50" },
] as const;

export type CreditPackId = (typeof CREDIT_PACKS)[number]["id"];

export function findPack(id: string) {
  return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Subscriptions.
 *
 * Same ledger, same balance, same spend path as a pack — a subscription is
 * just a recurring way to add `creditCents`, nothing downstream needs to know
 * the difference. Credits never expire and never reset on renewal (a
 * deliberate choice, same as packs): each period's grant is simply another
 * row, and the balance is still the sum.
 *
 * Monthly grants a 20% bonus over face value, matching the best one-off pack
 * (pack_50) rather than beating it — the reward for subscribing is the
 * recurring convenience, not a bonus packs can't also offer at that size.
 *
 * Yearly is priced at 10 months for 12 (a ~17% discount vs. paying monthly)
 * and grants the full year of credits in one lump sum on the first order,
 * rather than drip-feeding monthly — safe to do since credits roll over
 * indefinitely instead of expiring unused.
 */
export const SUBSCRIPTION_PLANS = [
  {
    id: "sub_monthly",
    interval: "month",
    priceCents: 2900,
    creditCents: 3500,
    label: "Monthly",
  },
  {
    id: "sub_yearly",
    interval: "year",
    priceCents: 29000,
    creditCents: 42000,
    label: "Yearly",
  },
] as const;

export type SubscriptionPlanId = (typeof SUBSCRIPTION_PLANS)[number]["id"];

export function findSubscriptionPlan(id: string) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === id);
}
