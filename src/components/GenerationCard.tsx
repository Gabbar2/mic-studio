"use client";

import { useEffect, useState } from "react";
import type { Generation } from "@/lib/types";
import { usd } from "@/lib/format";
import { creditLabel } from "@/lib/pricing";
import { QUALITY_LABEL } from "@/lib/models";
import { shortTitle } from "@/lib/title";
import { downloadFile } from "@/lib/download";
import SaveClip from "./SaveClip";
import {
  UPSCALE_LABEL,
  UPSCALE_TARGETS,
  upscaleChargeCents,
  upscaleCostCents,
  type UpscaleTarget,
} from "@/lib/upscale";

const RATIO_CLASS: Record<string, string> = {
  "16:9": "aspect-video",
  "9:16": "aspect-[9/16]",
  "1:1": "aspect-square",
};

/**
 * A gallery tile.
 *
 * The tile is a static image at rest. The <video> element is mounted only while
 * the pointer is over the card and unmounted when it leaves — a grid of 25
 * clips otherwise means 25 live media elements, each holding a connection and a
 * decoder for a ~24 Mbps 1080x1920 file, which is what makes an otherwise fine
 * 24fps render look choppy.
 */
export default function GenerationCard({
  generation: g,
  onOpen,
  onReuse,
  onUpscale,
  isAdmin = false,
  isTrial = false,
}: {
  generation: Generation;
  onOpen: () => void;
  onReuse: () => void;
  onUpscale: (target: UpscaleTarget) => Promise<void>;
  isAdmin?: boolean;
  isTrial?: boolean;
}) {
  const ratio = RATIO_CLASS[g.aspect_ratio] ?? "aspect-video";
  const pending = g.status === "queued" || g.status === "processing";
  const [hovering, setHovering] = useState(false);

  // Prefer our generated poster; fall back to the user's start frame while the
  // poster is still being made.
  const poster = g.thumbnail_url ?? g.source_image_url ?? null;
  const done = g.status === "succeeded" && !!g.video_url;

  return (
    <div
      className="group relative"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* Bloom. Sits outside the card and only on hover — a permanent glow on
          every card in a full grid turns the page into a light box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-2 rounded-2xl bg-accent-500/20 opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-100"
      />

      {/* Gradient rim. This replaces the flat border: one pixel of lime at the
          top-left corner fading to neutral by the middle, so the card reads as
          lit from one side rather than outlined. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[13px] opacity-55 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(145deg, rgba(198,248,44,0.5) 0%, rgba(198,248,44,0.08) 38%, rgba(34,39,29,0.95) 70%)",
        }}
      />

      <div className="relative overflow-hidden rounded-xl bg-gradient-to-b from-ink-850 via-ink-900 to-ink-950">
      <div className={`relative ${ratio} bg-ink-850`}>
        {done ? (
          <>
            <button
              type="button"
              onClick={onOpen}
              className="absolute inset-0 h-full w-full cursor-pointer"
              aria-label={`Open ${shortTitle(g.prompt)}`}
            >
              {poster ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <span className="text-[11px] text-ink-400">
                    Hover to preview
                  </span>
                </div>
              )}

              {hovering && (
                <video
                  src={g.video_url!}
                  poster={poster ?? undefined}
                  muted
                  loop
                  autoPlay
                  playsInline
                  preload="auto"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
            </button>

            {/* Sibling of the button, not a child — a button cannot nest one. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between p-1.5 opacity-0 transition group-hover:opacity-100">
              <button
                type="button"
                onClick={onReuse}
                className="pointer-events-auto rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white backdrop-blur transition hover:bg-black/85"
              >
                Reuse
              </button>
              <span className="rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white backdrop-blur">
                Expand
              </span>
            </div>
          </>
        ) : g.status === "failed" ? (
          <div className="flex h-full items-center justify-center px-4 text-center">
            <p className="text-xs leading-relaxed text-red-400">
              {g.error_message ?? "Generation failed"}
            </p>
          </div>
        ) : (
          <PendingState createdAt={g.created_at} poster={g.source_image_url} />
        )}
      </div>

      <div className="p-3">
        <p className="truncate text-xs font-medium leading-snug text-white">
          {shortTitle(g.prompt)}
        </p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[10px] text-ink-400">
            {g.duration_seconds}s &middot; {g.aspect_ratio} &middot;{" "}
            {QUALITY_LABEL[g.quality] ?? g.quality}
            {g.with_audio ? " · audio" : ""}
          </span>
          {done && (g.charged_cents ?? g.cost_cents) != null && (
            <span
              className="shrink-0 rounded border border-accent-500/40 px-1.5 py-0.5 text-[10px] tabular-nums text-accent-400"
              title={isAdmin ? `cost ${usd(g.cost_cents)}` : undefined}
            >
              {isAdmin
                ? usd(g.charged_cents ?? g.cost_cents)
                : `${creditLabel(g.charged_cents ?? g.cost_cents)} cr`}
            </span>
          )}
        </div>

        {/* A trial clip can be watched but not taken away. This is the ask,
            and it only appears once there is something worth keeping. */}
        {done && isTrial && (
          <div className="mt-2.5 border-t border-ink-800 pt-2.5">
            <SaveClip />
          </div>
        )}

        {done && !isTrial && (
          <UpscaleRow generation={g} onUpscale={onUpscale} isAdmin={isAdmin} />
        )}
      </div>

      {pending && <div className="h-0.5 w-full overflow-hidden bg-ink-800" />}
      </div>
    </div>
  );
}

/**
 * Upscale control.
 *
 * Both targets bill the same rate ($0.08/s above 1080p), so the price is shown
 * once rather than on each button.
 */
function UpscaleRow({
  generation: g,
  onUpscale,
  isAdmin,
}: {
  generation: Generation;
  onUpscale: (target: UpscaleTarget) => Promise<void>;
  isAdmin: boolean;
}) {
  const [busy, setBusy] = useState<UpscaleTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function handleDownload(url: string, filename: string) {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadFile(url, filename);
    } finally {
      setDownloading(false);
    }
  }

  const running =
    g.upscale_status === "queued" || g.upscale_status === "processing";
  const seconds = g.duration_actual ?? g.duration_seconds;

  async function go(target: UpscaleTarget) {
    setBusy(target);
    setError(null);
    try {
      await onUpscale(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the upscale.");
    } finally {
      setBusy(null);
    }
  }

  if (running) {
    return (
      <div className="mt-2.5 flex items-center gap-2 border-t border-ink-800 pt-2.5 text-[10px] text-ink-400">
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-ink-700 border-t-accent-500" />
        Upscaling to {UPSCALE_LABEL[g.upscale_target ?? "4k"]}…
      </div>
    );
  }

  if (g.upscale_status === "succeeded" && g.upscale_url) {
    return (
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-ink-800 pt-2.5 text-[10px]">
        <span className="rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-accent-400">
          {UPSCALE_LABEL[g.upscale_target ?? "4k"]} master
        </span>
        <button
          type="button"
          disabled={downloading}
          onClick={() =>
            void handleDownload(
              g.upscale_url!,
              `${g.id}-${g.upscale_target ?? "4k"}.mp4`,
            )
          }
          className="text-ink-300 transition hover:text-white disabled:opacity-50"
          title="Provider links expire — save this now."
        >
          {downloading ? "Downloading…" : "Download ↓"}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2.5 border-t border-ink-800 pt-2.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-ink-400">
        <span>
          Upscale{" "}
          <span className="tabular-nums text-ink-300">
            {isAdmin
              ? usd(upscaleCostCents(seconds))
              : `${creditLabel(upscaleChargeCents(seconds))} cr`}
          </span>
        </span>
        <div className="flex gap-1.5">
          {UPSCALE_TARGETS.map((t) => (
            <button
              key={t}
              onClick={() => go(t)}
              disabled={!!busy}
              className="rounded border border-ink-700 px-2 py-0.5 transition hover:border-accent-500 hover:text-white disabled:opacity-50"
            >
              {busy === t ? "…" : UPSCALE_LABEL[t]}
            </button>
          ))}
          <button
            type="button"
            disabled={downloading}
            onClick={() => void handleDownload(g.video_url!, `${g.id}.mp4`)}
            className="rounded border border-ink-700 px-2 py-0.5 transition hover:border-accent-500 hover:text-white disabled:opacity-50"
          >
            {downloading ? "…" : "↓"}
          </button>
        </div>
      </div>
      {(error ?? g.upscale_error) && (
        <p className="mt-1 text-[10px] leading-relaxed text-red-400">
          {error ?? g.upscale_error}
        </p>
      )}
    </div>
  );
}

function PendingState({
  createdAt,
  poster,
}: {
  createdAt: string;
  poster: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () =>
      setElapsed(
        Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <div className="shimmer relative flex h-full flex-col items-center justify-center overflow-hidden">
      {poster && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={poster}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover opacity-25 blur-[1px]"
        />
      )}
      <div className="relative z-10 h-6 w-6 animate-spin rounded-full border-2 border-ink-700 border-t-accent-500" />
      <p className="relative z-10 mt-3 text-[11px] tabular-nums text-ink-300">
        Rendering · {Math.floor(elapsed / 60)}:
        {String(elapsed % 60).padStart(2, "0")}
      </p>
    </div>
  );
}
