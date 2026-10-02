"use client";

import { useEffect } from "react";
import Link from "next/link";
import { UPGRADE_LOCK_COPY, type UpgradeLock } from "@/lib/trialLocks";

/**
 * The free tier's ask.
 *
 * Reuses SignInPrompt's shell — same rim, same card, same escape/backdrop
 * behavior — but the account already exists, so there is no email form here.
 * The only action is "go see the plans", which is /pricing.
 */
export default function UpgradePrompt({
  lock,
  onClose,
}: {
  lock: UpgradeLock;
  onClose: () => void;
}) {
  const copy = UPGRADE_LOCK_COPY[lock];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="relative w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[17px]"
          style={{
            background:
              "linear-gradient(150deg, rgba(198,248,44,0.55) 0%, rgba(198,248,44,0.09) 34%, rgba(34,39,29,0.95) 68%)",
          }}
        />

        <div className="relative rounded-2xl bg-gradient-to-b from-ink-850 via-ink-900 to-ink-950 p-6 shadow-2xl shadow-black/60">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-lg px-2 py-1 text-lg leading-none text-ink-400 transition hover:text-white"
          >
            ×
          </button>

          <h2 className="pr-6 text-base font-semibold leading-snug text-white">
            {copy.title}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-300">
            {copy.body}
          </p>

          <Link
            href="/pricing"
            onClick={onClose}
            className="mt-5 block w-full rounded-xl bg-accent-500 px-4 py-2.5 text-center text-sm font-semibold text-accent-ink transition hover:bg-accent-400"
          >
            {copy.cta}
          </Link>

          <button
            type="button"
            onClick={onClose}
            className="mt-3 w-full rounded-xl border border-ink-650 px-4 py-2.5 text-sm text-ink-200 transition hover:border-ink-600 hover:text-white"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
