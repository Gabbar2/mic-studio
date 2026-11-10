"use client";

import { useState } from "react";
import { captureThumbnail } from "@/lib/videoThumbnail";

function fmt(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1);
  return `${m}:${r.padStart(4, "0")}`;
}

/**
 * A scene's own "grab an extra still" control — a marker scrubbed within
 * that ONE scene's own [start, end] span (not the whole source video) plus
 * a "Take Snap" button, scoped to a single scene tile.
 *
 * Replaces the old arrangement where the big trim-range TrimTimeline at the
 * top of the page doubled as the snap-taker for "whichever clip was
 * prepared most recently" (see ReferenceEditor's old `activeClip`). That
 * stopped making sense once scene detection runs automatically and produces
 * every scene in one batch — there's no longer a meaningful "most recent
 * one" to single out, and a person naturally wants to pull extra stills
 * from whichever scene they're looking at, not just the last one. This is
 * deliberately a plain `<input type="range">` rather than TrimTimeline's own
 * hand-built draggable handles — no trim boundaries to move here, just one
 * position within an already-fixed span, so the native control (built-in
 * keyboard/accessibility support for free) is the simpler right tool.
 *
 * Captures via the same captureThumbnail helper the scene thumbnails and
 * TrimTimeline's own snap-taking already use, so this needs no CORS/
 * crossOrigin handling of its own.
 */
export default function SceneSnapTaker({
  sourceUrl,
  start,
  end,
  onTakeSnap,
}: {
  sourceUrl: string;
  start: number;
  end: number;
  onTakeSnap: (dataUrl: string, atSeconds: number) => void;
}) {
  const [markerAt, setMarkerAt] = useState(() => (start + end) / 2);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function take() {
    if (capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const dataUrl = await captureThumbnail(sourceUrl, markerAt, 960, 960);
      if (dataUrl) {
        onTakeSnap(dataUrl, markerAt);
      } else {
        setError("Could not capture a frame here — try a different moment.");
      }
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div
      className="space-y-1.5 rounded-lg border border-ink-650 bg-ink-900/60 p-2"
      // This whole control sits inside the scene tile's own <label> (the
      // include-checkbox toggle) — stop every interaction here from also
      // bubbling up and flipping that checkbox, same reasoning as the other
      // nested controls in that tile (download buttons, the headline
      // field).
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 text-[10px] text-ink-400">
        <span>
          📍 Snap marker at{" "}
          <span className="font-medium tabular-nums text-white">
            {fmt(markerAt)}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void take()}
          disabled={capturing}
          className="shrink-0 rounded-md bg-accent-500 px-2.5 py-1 text-[10px] font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-wait disabled:opacity-60"
        >
          {capturing ? "Capturing…" : "📸 Take Snap"}
        </button>
      </div>
      <input
        type="range"
        min={start}
        max={end}
        step={0.1}
        value={markerAt}
        onChange={(e) => setMarkerAt(Number(e.target.value))}
        className="w-full accent-accent-500"
        aria-label="Snap position within this scene"
      />
      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
