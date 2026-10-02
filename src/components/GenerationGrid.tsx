"use client";

import { useMemo } from "react";
import GenerationCard from "./GenerationCard";
import FailureStrip from "./FailureStrip";
import type { Generation } from "@/lib/types";
import type { UpscaleTarget } from "@/lib/upscale";

/**
 * The gallery column.
 *
 * Owns the split between failures and everything else, so the failure strip
 * and the grid can never disagree about what is in which — and so Studio does
 * not have to know about either.
 */
export default function GenerationGrid({
  generations,
  onOpen,
  onReuse,
  onUpscale,
  isAdmin = false,
  isTrial = false,
}: {
  generations: Generation[];
  onOpen: (g: Generation) => void;
  onReuse: (g: Generation) => void;
  onUpscale: (id: string, target: UpscaleTarget) => Promise<void>;
  isAdmin?: boolean;
  isTrial?: boolean;
}) {
  const { failures, rest } = useMemo(() => {
    const failures: Generation[] = [];
    const rest: Generation[] = [];
    for (const g of generations) {
      (g.status === "failed" ? failures : rest).push(g);
    }
    return { failures, rest };
  }, [generations]);

  if (!generations.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-5 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-ink-700 bg-ink-900 text-ink-600">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 4v16" />
            <path d="M16 4v16" />
          </svg>
        </div>
        <p className="text-sm font-medium text-ink-200">Nothing here yet</p>
        <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-ink-400">
          Describe a shot on the left and hit Generate. Clips take about a
          minute, and you are only charged when one succeeds.
        </p>
      </div>
    );
  }

  return (
    <>
      <FailureStrip failures={failures} onReuse={onReuse} />

      {rest.length > 0 && (
        <div className="mb-3.5 flex items-baseline gap-2.5">
          <h2 className="text-[13px] font-semibold text-white">Clips</h2>
          <span className="text-[11px] tabular-nums text-ink-400">
            {rest.length} &middot; {rest.reduce((n, g) => n + g.duration_seconds, 0)}s
          </span>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
        {rest.map((g) => (
          <GenerationCard
            key={g.id}
            generation={g}
            onOpen={() => g.video_url && onOpen(g)}
            onReuse={() => onReuse(g)}
            onUpscale={(target) => onUpscale(g.id, target)}
            isAdmin={isAdmin}
            isTrial={isTrial}
          />
        ))}
      </div>
    </>
  );
}
