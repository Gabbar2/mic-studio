"use client";

import { useEffect, useRef, useState } from "react";
import type { Generation } from "@/lib/types";
import { shortTitle } from "@/lib/title";

/**
 * Failed generations, folded into one line.
 *
 * A failure carries one useful sentence and nothing worth looking at, so
 * giving it the same tile as a finished clip is a bad trade — six dead tiles
 * push real work below the fold. Collapsed by default, openable when you
 * actually want to read the errors.
 */
export default function FailureStrip({
  failures,
  onReuse,
}: {
  failures: Generation[];
  onReuse: (g: Generation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const newestRef = useRef<string | null>(null);

  const newest = failures[0]?.id ?? null;

  // A dismissal covers the failures you have seen, not every future one — a
  // new failure has to be able to get your attention again.
  useEffect(() => {
    if (newest !== newestRef.current) {
      newestRef.current = newest;
      setDismissed(false);
    }
  }, [newest]);

  if (!failures.length || dismissed) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-red-500/25 bg-red-500/[0.06]">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="shrink-0 text-red-300"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5" />
            <path d="M12 16.5v.01" />
          </svg>
          <span className="truncate text-[11px] text-red-300">
            {failures.length} failed &middot; {summarise(failures)}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] text-ink-300 transition hover:text-white"
          >
            {open ? "Hide" : "Review"}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-[11px] text-ink-400 transition hover:text-white"
          >
            Dismiss
          </button>
        </div>
      </div>

      {open && (
        <ul className="border-t border-red-500/20 px-3 pb-2 pt-1">
          {failures.map((g) => (
            <li
              key={g.id}
              className="flex items-start justify-between gap-4 border-b border-red-500/10 py-2.5 last:border-b-0"
            >
              <div className="min-w-0">
                <p className="truncate text-[11px] text-ink-300">
                  {shortTitle(g.prompt)}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-400">
                  {g.error_message ?? "Generation failed"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onReuse(g)}
                className="shrink-0 text-[11px] text-ink-400 transition hover:text-white"
              >
                Reuse
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Distinct reasons rather than a count — three 422s are one problem. */
function summarise(failures: Generation[]): string {
  const counts = new Map<string, number>();

  for (const f of failures) {
    const key = condense(f.error_message ?? "Generation failed");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .slice(0, 3)
    .map(([msg, n]) => (n > 1 ? `${msg} × ${n}` : msg))
    .join(", ");
}

/** The first clause is the part that names the problem. */
function condense(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  let head = flat.split(/[.·\n]/)[0].trim();

  // A colon only splits when it leaves something meaningful in front of it.
  // "video_url: Video dimensions are too large" must not condense to
  // "video_url", which names a field rather than a problem.
  const colon = head.indexOf(":");
  if (colon >= 12) head = head.slice(0, colon).trim();

  return head.length > 46 ? `${head.slice(0, 46).trimEnd()}…` : head;
}
