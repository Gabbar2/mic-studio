"use client";

import { useEffect, useRef, useState } from "react";

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
 */
export default function TrimTimeline({
  src,
  durationSeconds,
  start,
  end,
  onRangeChange,
  capSeconds,
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
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playhead, setPlayhead] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);

  // Generates the thumbnail strip once per source — seeks a throwaway video
  // element to THUMBS evenly spaced points and captures each frame. Done
  // off-screen (not the visible <video>) so scrubbing for thumbnails never
  // visibly jumps the preview the person is looking at.
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

  // Pointer-drag for the two trim handles. Bound to the window rather than
  // the handle itself so a fast drag that outruns the handle's own hitbox
  // doesn't drop the gesture.
  useEffect(() => {
    if (!dragging) return;

    function clientXToSeconds(clientX: number): number {
      const track = trackRef.current;
      if (!track) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * durationSeconds;
    }

    function onMove(e: PointerEvent) {
      const t = clientXToSeconds(e.clientX);
      if (dragging === "start") {
        onRangeChange(Math.min(t, end - 0.2), end);
      } else {
        onRangeChange(start, Math.max(t, start + 0.2));
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
  const selected = end - start;
  const overCap = capSeconds > 0 && selected > capSeconds + 0.05;

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-ink-650 bg-black">
        <video
          ref={videoRef}
          src={src}
          controls
          className="aspect-video w-full"
          onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
        />
      </div>

      <div
        ref={trackRef}
        className="relative h-14 select-none overflow-hidden rounded-lg border border-ink-650 bg-ink-850"
      >
        <div className="absolute inset-0 flex">
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
          className="absolute inset-y-0 border-y-2 border-accent-400 bg-accent-500/25"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />

        {/* Playhead */}
        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-white/80"
          style={{
            left: `${durationSeconds ? (playhead / durationSeconds) * 100 : 0}%`,
          }}
        />

        {/* Start handle */}
        <button
          type="button"
          aria-label="Trim start"
          onPointerDown={() => setDragging("start")}
          className="absolute inset-y-0 w-3 cursor-ew-resize touch-none rounded-sm bg-accent-400"
          style={{ left: `calc(${startPct}% - 6px)` }}
        />
        {/* End handle */}
        <button
          type="button"
          aria-label="Trim end"
          onPointerDown={() => setDragging("end")}
          className="absolute inset-y-0 w-3 cursor-ew-resize touch-none rounded-sm bg-accent-400"
          style={{ left: `calc(${endPct}% - 6px)` }}
        />
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
        </span>
        <button
          type="button"
          onClick={() => onRangeChange(0, durationSeconds)}
          className="text-accent-400 underline underline-offset-2 hover:text-white"
        >
          Reset trim
        </button>
      </div>

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
