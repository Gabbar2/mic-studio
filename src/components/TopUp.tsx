"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import { creditLabel } from "@/lib/pricing";

interface Pack {
  id: string;
  priceCents: number;
  creditCents: number;
  label: string;
}

interface Plan {
  id: string;
  interval: string;
  priceCents: number;
  creditCents: number;
  label: string;
}

interface Subscription {
  plan_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

/**
 * Credit top-up and subscription management.
 *
 * Redirects to Polar's hosted checkout page rather than opening an in-page
 * overlay (Polar has no overlay/embedded mode equivalent to Paddle's — it's a
 * full-page redirect). No card details ever touch this app, which is what
 * keeps PCI scope at zero, and Polar is merchant of record so it handles the
 * tax as well.
 *
 * The redirect back to /studio does NOT mean credit has been granted, or a
 * subscription started. The balance and plan state update when the signed
 * webhook lands and the studio's next poll picks it up, which is usually a
 * second or two later.
 *
 * A pack purchase and a plan subscription both go through `buy()` — they hit
 * the same /api/checkout route with either `packId` or `planId`, and Polar
 * tells a one-time product from a recurring one apart on its own side.
 * Managing an existing subscription (cancel, change plan, payment method) is
 * deliberately NOT reimplemented here — "Manage subscription" opens Polar's
 * own hosted portal instead, so this file never drifts out of sync with what
 * Polar itself supports.
 */
export default function TopUp({
  balanceCents,
  packs,
  plans,
  subscription,
  isAdmin = false,
}: {
  balanceCents: number;
  packs: readonly Pack[];
  plans: readonly Plan[];
  subscription: Subscription | null;
  isAdmin?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);

  async function buy(idKey: "packId" | "planId", id: string) {
    setBusy(id);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [idKey]: id }),
      });
      const json = await res.json();

      if (!res.ok || !json.checkoutUrl) {
        setError(json.error ?? "Could not start checkout");
        setBusy(null);
        return;
      }

      window.location.assign(json.checkoutUrl as string);
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Network error — try again.",
      );
      setBusy(null);
    }
  }

  async function openPortal() {
    setPortalBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/portal", { method: "POST" });
      const json = await res.json();

      if (!res.ok || !json.portalUrl) {
        setError(json.error ?? "Could not open billing portal");
        setPortalBusy(false);
        return;
      }

      window.location.assign(json.portalUrl as string);
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Network error — try again.",
      );
      setPortalBusy(false);
    }
  }

  // "active" is Polar's steady-state status; a canceled subscription still
  // reports "active" until current_period_end, with cancel_at_period_end
  // true — that's shown as "ends <date>" rather than hidden, since credit is
  // still renewing (or was already granted, for the yearly lump sum) until
  // then.
  const isActive = subscription?.status === "active";
  const activePlan = isActive
    ? plans.find((p) => p.id === subscription?.plan_id)
    : undefined;

  return (
    <div className="border-t border-ink-800 pt-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-xs text-ink-300">Credits</span>
        <span
          className={`text-xs font-medium ${
            balanceCents <= 0 ? "text-amber-400" : "text-white"
          }`}
        >
          {isAdmin ? usd(balanceCents) : creditLabel(balanceCents)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {packs.map((p) => (
          <button
            key={p.id}
            onClick={() => buy("packId", p.id)}
            disabled={!!busy}
            className="flex flex-col items-center gap-0.5 rounded-lg border border-ink-700 px-2 py-2 transition hover:border-accent-500 disabled:opacity-50"
          >
            <span className="text-[11px] font-medium text-white">
              {busy === p.id ? "…" : p.label}
            </span>
            <span className="text-[9px] tabular-nums text-ink-400">
              {creditLabel(p.creditCents)}
            </span>
          </button>
        ))}
      </div>

      {/* Subscriptions get their own row rather than joining the pack grid —
          a plan is a different kind of decision (recurring) from a top-up,
          and blurring the two into one uniform button grid would make it
          easy to subscribe by accident while reaching for a pack. */}
      <div className="mt-3 border-t border-ink-800 pt-3">
        {isActive ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-ink-300">
              {activePlan?.label ?? "Subscribed"}
              {subscription?.cancel_at_period_end
                ? " · ends " +
                  (subscription.current_period_end
                    ? new Date(
                        subscription.current_period_end,
                      ).toLocaleDateString()
                    : "soon")
                : subscription?.current_period_end
                  ? " · renews " +
                    new Date(
                      subscription.current_period_end,
                    ).toLocaleDateString()
                  : ""}
            </span>
            <button
              onClick={openPortal}
              disabled={portalBusy}
              className="whitespace-nowrap rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-ink-200 transition hover:border-accent-500 disabled:opacity-50"
            >
              {portalBusy ? "…" : "Manage"}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {plans.map((p) => (
              <button
                key={p.id}
                onClick={() => buy("planId", p.id)}
                disabled={!!busy}
                className="flex flex-col items-center gap-0.5 rounded-lg border border-ink-700 px-2 py-2 transition hover:border-accent-500 disabled:opacity-50"
              >
                <span className="text-[11px] font-medium text-white">
                  {busy === p.id
                    ? "…"
                    : `${p.label} · $${(p.priceCents / 100).toFixed(0)}`}
                </span>
                <span className="text-[9px] tabular-nums text-ink-400">
                  {creditLabel(p.creditCents)}/{p.interval}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
