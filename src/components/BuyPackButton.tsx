"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Starts a Polar checkout for one credit pack, straight from the public
 * pricing page. Sibling to SubscribeButton.tsx — same /api/checkout route,
 * same sign-in redirect handling, same post-checkout caveats — split into
 * its own file only because a pack posts `packId` where a plan posts
 * `planId`, and `/api/checkout` treats the two as mutually exclusive (see
 * its own doc comment).
 */
export default function BuyPackButton({
  packId,
  label,
}: {
  packId: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.status === 401 || json.code === "email_required") {
        router.push(`/login?next=${encodeURIComponent("/pricing")}`);
        return;
      }

      if (!res.ok || !json.checkoutUrl) {
        setError(json.error ?? "Could not start checkout. Please try again.");
        setBusy(false);
        return;
      }

      // The redirect back to /studio?topup=success does NOT mean the credit
      // has landed yet — the balance updates once Polar's signed webhook
      // arrives, same caveat as TopUp.tsx and SubscribeButton.tsx.
      window.location.assign(json.checkoutUrl as string);
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Network error — check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={buy}
        disabled={busy}
        className="w-full rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
      >
        {busy ? "Starting checkout…" : label}
      </button>
      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
