"use client";

import { useEffect, useState } from "react";
import type { Generation } from "@/lib/types";
import { creditLabel } from "@/lib/pricing";
import { QUALITY_LABEL } from "@/lib/models";
import { UPSCALE_LABEL } from "@/lib/upscale";
import { downloadFile } from "@/lib/download";

export default function VideoModal({
  generation: g,
  onClose,
}: {
  generation: Generation;
  onClose: () => void;
}) {
  // One shared in-flight flag for both buttons below — a second click while
  // the first download's fetch is still running would start a second fetch
  // of the same multi-megabyte file for no reason.
  const [downloading, setDownloading] = useState<"video" | "upscale" | null>(
    null,
  );

  async function handleDownload(kind: "video" | "upscale", url: string, filename: string) {
    if (downloading) return;
    setDownloading(kind);
    try {
      await downloadFile(url, filename);
    } finally {
      setDownloading(null);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-ink-800 bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <video
          src={g.video_url!}
          controls
          autoPlay
          loop
          className="max-h-[70vh] w-full bg-black object-contain"
        />
        <div className="flex items-start justify-between gap-6 p-5">
          <div className="min-w-0">
            <p className="text-sm leading-relaxed text-ink-200">{g.prompt}</p>
            <p className="mt-2 text-[11px] text-ink-400">
              {g.model_id} · {g.duration_seconds}s · {g.aspect_ratio} ·{" "}
              {QUALITY_LABEL[g.quality] ?? g.quality}
              {g.with_audio ? " · audio" : ""}
              {(g.charged_cents ?? g.cost_cents) != null
                ? ` · ${creditLabel(g.charged_cents ?? g.cost_cents)} credits`
                : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {g.upscale_status === "succeeded" && g.upscale_url && (
              <button
                type="button"
                disabled={!!downloading}
                onClick={() =>
                  void handleDownload(
                    "upscale",
                    g.upscale_url!,
                    `${g.id}-${g.upscale_target ?? "4k"}.mp4`,
                  )
                }
                className="rounded-lg border border-accent-500/50 bg-accent-500/10 px-3 py-2 text-xs font-medium text-accent-400 transition hover:bg-accent-500/20 disabled:opacity-50"
                title="Provider links expire — save this now."
              >
                {downloading === "upscale"
                  ? "Downloading…"
                  : `${UPSCALE_LABEL[g.upscale_target ?? "4k"]} master`}
              </button>
            )}
            <button
              type="button"
              disabled={!!downloading}
              onClick={() =>
                void handleDownload("video", g.video_url!, `${g.id}.mp4`)
              }
              className="rounded-lg bg-accent-500 px-3 py-2 text-xs font-medium text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
            >
              {downloading === "video" ? "Downloading…" : "Download"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg border border-ink-700 px-3 py-2 text-xs text-ink-200 transition hover:bg-ink-800"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
