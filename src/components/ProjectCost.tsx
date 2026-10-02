"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usd } from "@/lib/format";
import {
  PROJECT_COST_LINES,
  projectCostRecurringCents,
  projectCostTotalCents,
} from "@/lib/projectCosts";

/**
 * The "spent today" figure in the header, with a cost breakdown that opens on
 * hover (desktop) or tap (mobile).
 *
 * Renders the trigger as well as the panel, so wiring it into the header is a
 * one-line swap.
 */
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * True only on devices with a real pointer.
 *
 * On a touch screen a synthetic hover fires on tap and then never clears,
 * which would leave the panel stuck open with no way to dismiss it — so touch
 * gets the tap-to-toggle path instead. The server snapshot is `false` so the
 * SSR markup matches the first client render.
 */
function useCanHover(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(HOVER_QUERY);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(HOVER_QUERY).matches,
    () => false,
  );
}

export default function ProjectCost({
  todayCents,
  totalCents,
}: {
  todayCents: number;
  totalCents: number;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const canHover = useCanHover();
  const ref = useRef<HTMLDivElement>(null);

  // Tap outside or press Escape to dismiss. Only bound while open, so an idle
  // page carries no listeners.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned]);

  const open = pinned || (canHover && hovered);
  const total = projectCostTotalCents();
  const recurring = projectCostRecurringCents();

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => canHover && setHovered(true)}
      onMouseLeave={() => canHover && setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        onFocus={() => canHover && setHovered(true)}
        onBlur={() => canHover && setHovered(false)}
        aria-expanded={open}
        aria-label="Spent today — show project cost breakdown"
        className="cursor-pointer rounded text-xs text-ink-400 transition hover:text-ink-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
      >
        <span className="text-ink-200">{usd(todayCents)}</span> spent today
      </button>

      {open && (
        // On phones the header scrolls horizontally, so an absolutely
        // positioned panel lands off-screen. Pin it to the viewport there, and
        // only anchor it to the button from `sm` up.
        //
        // From `sm`: pt-2 rather than mt-2 keeps the hit area contiguous with
        // the button, so moving the cursor into the panel does not close it.
        <div className="fixed inset-x-3 top-14 z-30 sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:pt-2">
          <div className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-left shadow-xl sm:w-72">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-400">
              Project cost
            </p>

            {/* Each line is one link covering both the label and the amount,
                which also gives a comfortable tap target on mobile. */}
            <div className="-mx-1.5 space-y-0.5 text-xs">
              {PROJECT_COST_LINES.map((line) => (
                <a
                  key={line.label}
                  href={line.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-baseline justify-between gap-3 rounded-lg px-1.5 py-1 transition hover:bg-ink-800"
                >
                  <span className="text-ink-300 group-hover:text-white">
                    {line.label}
                    {line.note && (
                      <span className="ml-1.5 text-[10px] text-ink-500">
                        {line.note}
                      </span>
                    )}
                    {/* Kept on the label side so the amounts stay in a clean
                        right-aligned column. */}
                    <span
                      aria-hidden
                      className="ml-1 text-[9px] text-accent-400 opacity-0 transition group-hover:opacity-100"
                    >
                      ↗
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-100">
                    {usd(line.cents)}
                  </span>
                </a>
              ))}
            </div>

            <div className="mt-2.5 flex items-baseline justify-between gap-3 border-t border-ink-800 pt-2.5 text-xs">
              <span className="font-medium text-ink-200">Total</span>
              <span className="shrink-0 tabular-nums font-semibold text-white">
                {usd(total)}
              </span>
            </div>

            {recurring > 0 && (
              <p className="mt-1 text-[10px] text-ink-500">
                {usd(recurring)} of that repeats every month.
              </p>
            )}

            <div className="mt-3 space-y-1.5 border-t border-ink-800 pt-2.5 text-xs">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Actually spent
              </p>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink-300">Today</span>
                <span className="shrink-0 tabular-nums text-ink-100">
                  {usd(todayCents)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink-300">All time</span>
                <span className="shrink-0 tabular-nums text-ink-100">
                  {usd(totalCents)}
                </span>
              </div>
            </div>

            <p className="mt-2.5 text-[10px] leading-relaxed text-ink-500">
              Each line opens its billing page. Budget figures are set in{" "}
              <span className="text-ink-400">lib/projectCosts.ts</span>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
