"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Starts a Polar checkout for one subscription plan, straight from the
 * public pricing page.
 *
 * Same /api/checkout route TopUp.tsx already uses from inside the studio —
 * this just gives the marketing page its own entry point, since a visitor
 * reading /pricing has no reason to go find the studio's account menu first.
 *
 * /api/checkout requires a signed-in account with a real email (see its own
 * doc comment): a trial visitor has neither yet. Rather than fail silently,
 * a 401 (no session) or the `email_required` code (an anonymous trial
 * session with no email) sends them to /login first, with `next` pointed
 * back at /pricing so they land here again and can press Subscribe a second
 * time once they're signed in properly.
 */
export default function SubscribeButton({
  planId,
  label,
}: {
  planId: string;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
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

      // The redirect back to /studio?subscribed=success does NOT mean the
      // subscription is active yet — same caveat as TopUp.tsx. The balance
      // updates once Polar's signed webhook lands.
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
        onClick={subscribe}
        disabled={busy}
        className="w-full rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
      >
        {busy ? "Starting checkout…" : label}
      </button>
      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
