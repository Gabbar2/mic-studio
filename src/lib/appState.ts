import { createAdminClient } from "./supabase/admin";

/**
 * Server-side operational state.
 *
 * Everything here is written by the cron and read by the request path, which
 * is the point: the fal balance costs an API call to fetch, and the generate
 * route needs it on every request. Caching it turns a network round-trip into
 * a primary-key read.
 *
 * Nothing in here is configuration and nothing is user-visible. The table has
 * RLS on with no policies, so the service role is the only way in.
 */

export interface ProviderBalance {
  /** Cents at the provider, or null when it has never been measured. */
  cents: number | null;
  checked_at: string | null;
}

async function read<T>(key: string, fallback: T): Promise<T> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("app_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value as T) ?? fallback;
}

async function write(key: string, value: unknown): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("app_state")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
}

export async function getProviderBalance(): Promise<ProviderBalance> {
  return read<ProviderBalance>("provider_balance", {
    cents: null,
    checked_at: null,
  });
}

export async function setProviderBalance(cents: number | null): Promise<void> {
  await write("provider_balance", {
    cents,
    checked_at: new Date().toISOString(),
  });
}

export async function getLowBalanceAlert(): Promise<{ sent_at: string | null }> {
  return read<{ sent_at: string | null }>("low_balance_alert", {
    sent_at: null,
  });
}

export async function setLowBalanceAlert(sentAt: string | null): Promise<void> {
  await write("low_balance_alert", { sent_at: sentAt });
}

/**
 * The balance the guard should decide on, refreshing it if it has gone stale.
 *
 * Vercel's Hobby plan allows one cron a day, so the cron alone would leave the
 * cache up to 24 hours old — useless for deciding whether a generation can be
 * honoured right now. This tops it up from the request path instead, but only
 * when the cached figure is older than maxAgeMs, so the cost is a handful of
 * provider calls an hour no matter how much traffic arrives.
 *
 * Never throws. A failed refresh returns the stale figure, and a stale figure
 * is better than an outage.
 */
export async function providerBalanceCentsFresh(
  maxAgeMs = 15 * 60 * 1000,
): Promise<number | null> {
  const cached = await getProviderBalance();

  const age = cached.checked_at
    ? Date.now() - new Date(cached.checked_at).getTime()
    : Infinity;
  if (age < maxAgeMs) return cached.cents;

  try {
    const { activeProvider } = await import("./providers");
    const provider = activeProvider();
    if (!provider.getBalance) return cached.cents;

    const result = await provider.getBalance();
    const cents =
      typeof result?.balance === "number"
        ? Math.round(result.balance * 100)
        : null;
    await setProviderBalance(cents);
    return cents;
  } catch {
    return cached.cents;
  }
}

/**
 * What the app still owes its customers, in cents of customer-facing credit.
 * Sum of the whole ledger — see credit_liability() in migration 0009.
 */
export async function creditLiabilityCents(): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("credit_liability");
  return typeof data === "number" ? data : 0;
}

/**
 * The provider cost that an outstanding credit balance represents.
 *
 * Customers are charged cost x markup, so the cost behind a charge is the
 * charge divided by the markup. If every customer spent every credit they
 * hold, this is the bill that would land at fal.
 */
export function liabilityAsProviderCents(
  liabilityCents: number,
  markup: number,
): number {
  const rate = Number.isFinite(markup) && markup > 0 ? markup : 1.8;
  return Math.round(liabilityCents / rate);
}
