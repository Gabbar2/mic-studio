"use client";

import { useEffect, useRef, useState } from "react";
import { captureThumbnail } from "@/lib/videoThumbnail";

const THUMBS = 10;

function fmt(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = (s % 60).toFixed(1);
  return `${m}:${r.padStart(4, "0")}`;
}

/**
 * The video preview, a thumbnail strip, and a draggable trim range on top of
 * it — Point 2 of the brief. Deliberately built on the native <video>
 * element and a <canvas> for thumbnails rather than a video-editing library:
 * the only things this actually needs are "seek to a time" and "draw the
 * current frame to a 2D context", both of which the browser already does.
 *
 * Once a clip has been prepared (`locked`), this collapses down to just the
 * thumbnail strip: the video preview hides (there's nothing left to play or
 * scrub for — a snap's position comes from dragging the 📍 marker handle
 * below, not the video's own playhead) and the two trim handles stop
 * responding, permanently, for this trim session — there's no "unlock"
 * control. Picking a different range means trimming again before that
 * next clip's own Prepare run.
 */
export default function TrimTimeline({
  src,
  durationSeconds,
  start,
  end,
  onRangeChange,
  capSeconds,
  canTakeSnap,
  onTakeSnap,
  snapMarkers,
  locked,
}: {
  src: string;
  durationSeconds: number;
  start: number;
  end: number;
  onRangeChange: (start: number, end: number) => void;
  /** The selected model's reference-video cap — purely for the "exceeds
   * limit" banner and segment preview below; this component never clamps
   * the range itself, so switching to a roomier model doesn't lose a trim
   * the person already made. */
  capSeconds: number;
  /** Whether the snap marker + "Take Snap" should be offered at all — the
   * parent only passes true once at least one clip has actually been
   * prepared, since a snap is grabbed *for* an already-prepared clip (its
   * edits get folded into that clip's own image references — see
   * ReferenceEditor's handleTakeSnap), not a standalone thing. This is
   * always equal to `locked` in practice (both key off clips.length > 0)
   * but kept as its own prop since they mean different things. */
  canTakeSnap: boolean;
  /** Fired with a freshly captured frame (a JPEG data URL) and the exact
   * moment it was taken at, once "Take Snap" finishes capturing wherever
   * the draggable 📍 marker handle currently sits — via the same
   * captureThumbnail helper the scene-clip thumbnails already use, rather
   * than drawing a live <video> element directly, so this doesn't need its
   * own CORS/crossOrigin handling. */
  onTakeSnap: (dataUrl: string, atSeconds: number) => void;
  /** Where to draw a small dimmed 📍 pin on the track for each snap already
   * taken for the clip these snaps belong to — distinct from the larger,
   * draggable marker handle, which is where the *next* snap will be taken
   * from. Purely informational otherwise; nothing to click here. */
  snapMarkers: number[];
  /** True once a clip has been prepared — collapses the video preview and
   * disables the two trim handles, for good, for this trim session (see
   * the component doc comment above). */
  locked: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [dragging, setDragging] = useState<"start" | "end" | "marker" | null>(
    null,
  );
  const [snapping, setSnapping] = useState(false);
  const [snapError, setSnapError] = useState<string | null>(null);
  // Where the next "Take Snap" will capture from — the draggable marker
  // handle's own position, independent of the (now-hidden) video's
  // playhead. null means "not yet moved", which renders/captures at the
  // start of the trimmed range; reset back to null each time a fresh trim
  // session locks (see the effect below), so a new clip's marker doesn't
  // inherit the previous one's position.
  // null means "not yet moved", which renders/captures at the start of the
  // trimmed range. No reset-on-relock logic needed here: the trim range
  // locks for good after the first clip is prepared (no "unlock" control —
  // see the component doc comment above), so `locked` only ever flips
  // false→true once per mount of this component; a genuinely fresh trim
  // session (e.g. after "Replace video") remounts TrimTimeline entirely,
  // which already starts markerAt back at null.
  const [markerAt, setMarkerAt] = useState<number | null>(null);
  const effectiveMarkerAt = Math.min(
    Math.max(markerAt ?? start, start),
    end,
  );

  async function takeSnap() {
    if (snapping) return;
    setSnapping(true);
    setSnapError(null);
    try {
      const dataUrl = await captureThumbnail(src, effectiveMarkerAt, 960, 960);
      if (dataUrl) {
        onTakeSnap(dataUrl, effectiveMarkerAt);
      } else {
        // Same CORS caveat as the thumbnail strip below — a pasted URL
        // without permissive headers can't be captured from here.
        setSnapError(
          "Could not capture a frame here — this source may be blocking it. Try a different moment, or a file you uploaded directly.",
        );
      }
    } finally {
      setSnapping(false);
    }
  }

  // Generates the thumbnail strip once per source — seeks a throwaway video
  // element to THUMBS evenly spaced points and captures each frame. Done
  // off-screen (never the visible preview, even before `locked`) so
  // scrubbing for thumbnails never visibly jumps the preview the person is
  // looking at.
  useEffect(() => {
    if (!durationSeconds) return;
    let cancelled = false;
    const probe = document.createElement("video");
    probe.src = src;
    probe.muted = true;
    probe.crossOrigin = "anonymous";
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 54;
    const ctx = canvas.getContext("2d");

    async function run() {
      const out: string[] = [];
      if (!ctx) return;
      try {
        await new Promise<void>((resolve, reject) => {
          probe.onloadedmetadata = () => resolve();
          probe.onerror = () => reject(new Error("Could not load video"));
        });
        for (let i = 0; i < THUMBS; i++) {
          if (cancelled) return;
          const t = (durationSeconds * (i + 0.5)) / THUMBS;
          await new Promise<void>((resolve) => {
            probe.onseeked = () => resolve();
            probe.currentTime = t;
          });
          if (cancelled) return;
          ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.6));
        }
        if (!cancelled) setThumbs(out);
      } catch {
        // A pasted URL without permissive CORS headers taints the canvas on
        // drawImage/toDataURL — the strip just stays empty ("Generating
        // thumbnails…" never resolves away) rather than crashing the page.
        // Trimming and preparing the clip both work fine without it.
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [src, durationSeconds]);

  // Pointer-drag for the trim handles and the snap marker. Bound to the
  // window rather than the handle itself so a fast drag that outruns the
  // handle's own hitbox doesn't drop the gesture.
  useEffect(() => {
    if (!dragging) return;

    function clientXToSeconds(clientX: number): number {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * durationSeconds;
    }

    function onMove(e: globalThis.PointerEvent) {
      const t = clientXToSeconds(e.clientX);
      if (dragging === "start") {
        onRangeChange(Math.min(t, end - 0.2), end);
      } else if (dragging === "end") {
        onRangeChange(start, Math.max(t, start + 0.2));
      } else {
        setMarkerAt(Math.min(Math.max(t, start), end));
      }
    }
    function onUp() {
      setDragging(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, start, end, durationSeconds]);

  const startPct = durationSeconds ? (start / durationSeconds) * 100 : 0;
  const endPct = durationSeconds ? (end / durationSeconds) * 100 : 100;
  const markerPct = durationSeconds
    ? (effectiveMarkerAt / durationSeconds) * 100
    : 0;
  const selected = end - start;
  const overCap = capSeconds > 0 && selected > capSeconds + 0.05;

  return (
    <div className="space-y-3">
      {!locked && (
        <div className="relative overflow-hidden rounded-lg border border-ink-650 bg-black">
          <video
            src={src}
            controls
            className="aspect-video w-full"
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
          />
        </div>
      )}

      <div
        ref={trackRef}
        className="relative h-14 select-none overflow-visible rounded-lg border border-ink-650 bg-ink-850"
      >
        <div className="absolute inset-0 overflow-hidden rounded-lg">
          <div className="flex h-full">
            {thumbs.length ? (
              thumbs.map((t, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={t}
                  alt=""
                  className="h-full flex-1 object-cover opacity-70"
                />
              ))
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[10px] text-ink-500">
                Generating thumbnails…
              </div>
            )}
          </div>

          {/* Selected range */}
          <div
            className="pointer-events-none absolute inset-y-0 border-y-2 border-accent-400 bg-accent-500/25"
            style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
          />

          {/* Live playhead — only meaningful while the preview above is
              still shown. */}
          {!locked && (
            <div
              className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
              style={{
                left: `${durationSeconds ? (playhead / durationSeconds) * 100 : 0}%`,
              }}
            />
          )}
        </div>

        {/* Already-taken snaps — small, dimmed, static pins, distinct from
            the larger draggable marker handle below (where the *next* snap
            will come from). Drawn above the clipped box (overflow-visible
            on the track) so the pin isn't clipped off at the top edge. */}
        {snapMarkers.map((t, i) => (
          <div
            key={i}
            className="pointer-events-none absolute -top-3 flex -translate-x-1/2 flex-col items-center opacity-60"
            style={{
              left: `${durationSeconds ? (t / durationSeconds) * 100 : 0}%`,
            }}
          >
            <span className="text-[10px] leading-none">📍</span>
          </div>
        ))}

        {/* Start handle */}
        <button
          type="button"
          aria-label="Trim start"
          disabled={locked}
          onPointerDown={() => {
            if (!locked) setDragging("start");
          }}
          className={`absolute inset-y-0 w-3 touch-none rounded-sm ${
            locked
              ? "cursor-not-allowed bg-ink-600"
              : "cursor-ew-resize bg-accent-400"
          }`}
          style={{ left: `calc(${startPct}% - 6px)` }}
        />
        {/* End handle */}
        <button
          type="button"
          aria-label="Trim end"
          disabled={locked}
          onPointerDown={() => {
            if (!locked) setDragging("end");
          }}
          className={`absolute inset-y-0 w-3 touch-none rounded-sm ${
            locked
              ? "cursor-not-allowed bg-ink-600"
              : "cursor-ew-resize bg-accent-400"
          }`}
          style={{ left: `calc(${endPct}% - 6px)` }}
        />

        {/* Snap marker handle — where the next "Take Snap" captures from.
            Draggable the same way the trim handles are, just along a
            different axis of meaning (position to capture, not range
            boundary), and only offered once there's a clip to attach a
            snap to. */}
        {canTakeSnap && (
          <button
            type="button"
            aria-label="Snap marker — drag to the frame you want, then press Take Snap"
            title="Drag to the frame you want, then press Take Snap"
            onPointerDown={() => setDragging("marker")}
            className="absolute -top-4 flex -translate-x-1/2 touch-none flex-col items-center"
            style={{ left: `${markerPct}%` }}
          >
            <span className="cursor-ew-resize text-base leading-none drop-shadow">
              📍
            </span>
            <span className="h-14 w-0.5 bg-accent-300/70" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-400">
        <span>
          Selected{" "}
          <span className="font-medium text-white tabular-nums">
            {fmt(selected)}
          </span>{" "}
          of {fmt(durationSeconds)} ·{" "}
          <span className="tabular-nums">
            {fmt(start)} → {fmt(end)}
          </span>
          {locked && <span className="text-ink-500"> · 🔒 locked</span>}
        </span>
        {!locked && (
          <button
            type="button"
            onClick={() => onRangeChange(0, durationSeconds)}
            className="text-accent-400 underline underline-offset-2 hover:text-white"
          >
            Reset trim
          </button>
        )}
      </div>

      {canTakeSnap && (
        <div className="flex items-center gap-2 rounded-lg border border-accent-500/60 bg-accent-500/10 px-2.5 py-1.5 text-[11px]">
          <span className="text-accent-300">
            📍 Marker at{" "}
            <span className="font-medium tabular-nums text-white">
              {fmt(effectiveMarkerAt)}
            </span>
          </span>
          <span className="text-ink-500">— drag it above, then</span>
          <button
            type="button"
            onClick={() => void takeSnap()}
            disabled={snapping}
            className="ml-auto shrink-0 rounded-md bg-accent-500 px-3 py-1 font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-wait disabled:opacity-60"
          >
            {snapping ? "Capturing…" : "📸 Take Snap"}
          </button>
        </div>
      )}

      {snapError && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
          {snapError}
        </p>
      )}

      {overCap && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          This model&apos;s reference video tops out at {fmt(capSeconds)}.
          Your {fmt(selected)} selection will be split into even clips at
          that length when you prepare it — nothing outside your selection
          is discarded, and no footage inside it is dropped either. Trim
          further above if you&apos;d rather send one clip instead.
        </p>
      )}
    </div>
  );
}
