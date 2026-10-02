"use client";

import { useEffect } from "react";
import type { Generation } from "@/lib/types";
import { creditLabel } from "@/lib/pricing";
import { QUALITY_LABEL } from "@/lib/models";
import { UPSCALE_LABEL } from "@/lib/upscale";

export default function VideoModal({
  generation: g,
  onClose,
}: {
  generation: Generation;
  onClose: () => void;
}) {
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
              <a
                href={g.upscale_url}
                download={`${g.id}-${g.upscale_target ?? "4k"}.mp4`}
                className="rounded-lg border border-accent-500/50 bg-accent-500/10 px-3 py-2 text-xs font-medium text-accent-400 transition hover:bg-accent-500/20"
                title="Provider links expire — save this now."
              >
                {UPSCALE_LABEL[g.upscale_target ?? "4k"]} master
              </a>
            )}
            <a
              href={g.video_url!}
              download={`${g.id}.mp4`}
              className="rounded-lg bg-accent-500 px-3 py-2 text-xs font-medium text-accent-ink transition hover:bg-accent-400"
            >
              Download
            </a>
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
