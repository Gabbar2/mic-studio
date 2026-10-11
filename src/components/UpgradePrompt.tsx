"use client";

import { useEffect } from "react";
import Link from "next/link";
import { UPGRADE_LOCK_COPY, type UpgradeLock } from "@/lib/trialLocks";
import {
  DEFAULT_MODEL_ID,
  durationsFor,
  effectiveMarkup,
  estimateCostCents,
  getModel,
  qualitiesFor,
  QUALITY_LABEL,
  type GenerationMode,
} from "@/lib/models";
import { creditLabel, roundChargeCents } from "@/lib/pricing";
import { FREE_DURATIONS, FREE_QUALITY } from "@/lib/freeTier";

/**
 * The free tier's ask.
 *
 * Reuses SignInPrompt's shell — same rim, same card, same escape/backdrop
 * behavior — but the account already exists, so there is no email form here.
 * The only action is "go see the plans", which is /pricing.
 *
 * Below the copy, a small cost table answers the question this modal used to
 * leave open: "upgrade to *what*, exactly?" It prices every quality ×
 * duration combination the locked feature actually offers, against the
 * account's own balance — so "needs an upgrade" comes with a number instead
 * of being a wall. Cells the free tier can already reach (Standard, 5s/10s)
 * are marked rather than hidden, so the table reads as "here's what's new",
 * not a duplicate of controls already on screen.
 */
export default function UpgradePrompt({
  lock,
  onClose,
  creditCents,
  priceMarkup = 1,
  modelId,
  mode = "text2video",
  withAudio = false,
}: {
  lock: UpgradeLock;
  onClose: () => void;
  /** The account's current balance, in cents. Omit to hide affordability. */
  creditCents?: number;
  priceMarkup?: number;
  /** Defaults to the trial/default model — whatever Composer last had selected. */
  modelId?: string;
  /** Ignored for the "reference" lock, which always prices reference2video. */
  mode?: GenerationMode;
  withAudio?: boolean;
}) {
  const copy = UPGRADE_LOCK_COPY[lock];
  const model = getModel(modelId ?? DEFAULT_MODEL_ID) ?? getModel(DEFAULT_MODEL_ID)!;
  const effectiveMode: GenerationMode =
    lock === "reference" ? "reference2video" : mode;

  const qualities = qualitiesFor(model, effectiveMode);
  const durations = durationsFor(model, effectiveMode);
  const markup = effectiveMarkup(model, priceMarkup);
  const haveBalance = creditCents != null;

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
        className="relative w-full max-w-md"
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

          {haveBalance && (
            <p className="mt-3 text-xs text-ink-400">
              Your balance:{" "}
              <span className="font-medium text-white">
                {creditLabel(creditCents)} credits
              </span>
            </p>
          )}

          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-700">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr>
                  <th className="border-b border-ink-700 bg-ink-850 px-2.5 py-2 text-left font-medium text-ink-400">
                    Quality \ Duration
                  </th>
                  {durations.map((d) => (
                    <th
                      key={d}
                      className="border-b border-ink-700 bg-ink-850 px-2.5 py-2 text-right font-medium text-ink-400"
                    >
                      {d}s
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {qualities.map((q, qi) => (
                  <tr key={q}>
                    <td
                      className={`px-2.5 py-2 text-left font-medium ${
                        qi < qualities.length - 1 ? "border-b border-ink-800" : ""
                      } text-ink-200`}
                    >
                      {QUALITY_LABEL[q]}
                    </td>
                    {durations.map((d, di) => {
                      const onFreeTier =
                        lock !== "reference" &&
                        q === FREE_QUALITY &&
                        (FREE_DURATIONS as readonly number[]).includes(d);
                      const cost = estimateCostCents(
                        model,
                        effectiveMode,
                        q,
                        d,
                        withAudio && model.supportsAudio,
                      );
                      const price = roundChargeCents(cost * markup);
                      const short = haveBalance
                        ? Math.max(0, price - creditCents)
                        : 0;
                      return (
                        <td
                          key={d}
                          className={`px-2.5 py-2 text-right ${
                            qi < qualities.length - 1
                              ? "border-b border-ink-800"
                              : ""
                          } ${di > 0 ? "border-l border-ink-800" : ""}`}
                        >
                          {onFreeTier ? (
                            <span className="text-ink-500">on your plan</span>
                          ) : (
                            <div>
                              <span
                                className={
                                  haveBalance && short > 0
                                    ? "text-ink-200"
                                    : "text-white"
                                }
                              >
                                {creditLabel(price)}
                              </span>
                              {haveBalance && short > 0 && (
                                <div className="text-[10px] text-amber-400/90">
                                  +{creditLabel(short)} short
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-ink-500">
            Prices in credits
            {withAudio && model.supportsAudio ? ", with audio on" : ""}. Cells
            marked &ldquo;on your plan&rdquo; already work without upgrading.
          </p>

          <Link
            href="/pricing"
            onClick={onClose}
            className="mt-4 block w-full rounded-xl bg-accent-500 px-4 py-2.5 text-center text-sm font-semibold text-accent-ink transition hover:bg-accent-400"
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
