import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeProvider, providerFor } from "@/lib/providers";
import {
  creditLiabilityCents,
  getLowBalanceAlert,
  liabilityAsProviderCents,
  setLowBalanceAlert,
  setProviderBalance,
} from "@/lib/appState";
import {
  alertsConfigured,
  lowBalanceThresholdCents,
  sendLowBalanceAlert,
} from "@/lib/alerts";
import { applyTaskUpdate } from "@/lib/generations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STALE_AFTER_MINUTES = 30;

/**
 * Safety net for jobs whose webhook never arrived (deploy in progress, region
 * blip, callback URL misconfigured). Wire to Vercel Cron every 5 minutes —
 * see vercel.json.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Forbidden" }, { status: 401 });
    }
  }

  const admin = createAdminClient();
  const { data: pending } = await admin
    .from("generations")
    .select("id, provider, provider_task_id, mode, quality, model_id, created_at")
    .in("status", ["queued", "processing"])
    .not("provider_task_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(50);

  let refreshed = 0;
  let abandoned = 0;

  for (const p of pending ?? []) {
    const ageMin = (Date.now() - new Date(p.created_at).getTime()) / 60000;

    try {
      const provider = providerFor(p.provider, p.provider_task_id!);
      const task = await provider.get(
        p.provider_task_id!,
        p.mode,
        p.quality,
        p.model_id,
      );
      await applyTaskUpdate(p.provider_task_id!, task);
      refreshed++;
    } catch (e) {
      console.error("[cron/poll]", p.id, e);
      if (ageMin > STALE_AFTER_MINUTES) {
        await admin
          .from("generations")
          .update({
            status: "failed",
            error_message: "Timed out waiting for the provider",
            completed_at: new Date().toISOString(),
          })
          .eq("id", p.id);
        abandoned++;
      }
    }
  }

  // --- balance watch -------------------------------------------------------
  // Runs after the polling work and never throws into it. The cron's job is to
  // rescue stuck generations; a monitoring feature must not be able to stop
  // that happening.
  const balance = await watchBalance();

  return NextResponse.json({
    checked: pending?.length ?? 0,
    refreshed,
    abandoned,
    balance,
  });
}

/**
 * Read the provider balance, cache it for the generate route, and email once
 * if it has fallen below the threshold.
 *
 * The alert latches: it fires when the balance crosses down, and does not fire
 * again until the balance recovers above the threshold. A warning that arrives
 * every five minutes is a warning you learn to ignore, and the whole point is
 * that this one gets read.
 */
async function watchBalance(): Promise<{
  cents: number | null;
  alerted: boolean;
}> {
  try {
    const provider = activeProvider();
    if (!provider.getBalance) return { cents: null, alerted: false };

    const result = await provider.getBalance();
    const cents =
      typeof result?.balance === "number"
        ? Math.round(result.balance * 100)
        : null;

    await setProviderBalance(cents);
    if (cents == null) return { cents: null, alerted: false };

    const threshold = lowBalanceThresholdCents();
    const latch = await getLowBalanceAlert();

    if (cents >= threshold) {
      // Recovered — disarm so the next fall alerts again.
      if (latch.sent_at) await setLowBalanceAlert(null);
      return { cents, alerted: false };
    }

    if (latch.sent_at || !alertsConfigured()) return { cents, alerted: false };

    const liability = await creditLiabilityCents();
    const sent = await sendLowBalanceAlert({
      balanceCents: cents,
      liabilityProviderCents: liabilityAsProviderCents(
        liability,
        Number(process.env.PRICE_MARKUP ?? 1.8),
      ),
      thresholdCents: threshold,
    });

    if (sent) await setLowBalanceAlert(new Date().toISOString());
    return { cents, alerted: sent };
  } catch (e) {
    console.error("[cron/poll] balance watch", e);
    return { cents: null, alerted: false };
  }
}
