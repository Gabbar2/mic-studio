"use client";

import { useEffect, useRef } from "react";
import type { Generation } from "@/lib/types";

const WIDTH = 480; // poster width — a ~40 KB JPEG instead of a 29 MB MP4
const SEEK_TO = 0.1; // first frame is sometimes black; 100ms in is safe

/**
 * Captures a poster frame for any finished clip that doesn't have one yet.
 *
 * Runs one clip at a time, off-screen, and only while the tab is visible. The
 * cost is paid once per generation; from then on the gallery is images.
 *
 * Server-side extraction would be cleaner but needs ffmpeg in the runtime,
 * which rules out serverless deploys. The browser already has a video decoder.
 */
export default function ThumbnailBackfill({
  generations,
  onThumbnail,
}: {
  generations: Generation[];
  onThumbnail: (id: string, url: string) => void;
}) {
  const running = useRef(false);
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = generations.filter(
      (g) =>
        g.status === "succeeded" &&
        g.video_url &&
        !g.thumbnail_url &&
        !attempted.current.has(g.id),
    );

    if (!pending.length || running.current) return;
    if (typeof document !== "undefined" && document.hidden) return;

    let cancelled = false;
    running.current = true;

    (async () => {
      for (const g of pending) {
        if (cancelled) break;
        attempted.current.add(g.id);

        try {
          const blob = await captureFrame(g.video_url!);
          if (!blob || cancelled) continue;

          const body = new FormData();
          body.append("generationId", g.id);
          body.append("file", new File([blob], "poster.jpg", { type: "image/jpeg" }));

          const res = await fetch("/api/thumbnail", { method: "POST", body });
          if (!res.ok) continue;

          const json = await res.json();
          if (!cancelled) onThumbnail(g.id, json.url as string);
        } catch {
          // A failed capture is cosmetic — the card falls back to its start
          // frame, or to a placeholder. Never retried within this session.
        }
      }
      running.current = false;
    })();

    return () => {
      cancelled = true;
      running.current = false;
    };
  }, [generations, onThumbnail]);

  return null;
}

function captureFrame(url: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
    };

    const fail = () => {
      cleanup();
      resolve(null);
    };

    const timeout = setTimeout(fail, 20000);

    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(SEEK_TO, (video.duration || 1) / 2);
      } catch {
        fail();
      }
    };

    video.onseeked = () => {
      clearTimeout(timeout);
      try {
        const scale = WIDTH / (video.videoWidth || WIDTH);
        const canvas = document.createElement("canvas");
        canvas.width = WIDTH;
        canvas.height = Math.round((video.videoHeight || WIDTH) * scale);

        const ctx = canvas.getContext("2d");
        if (!ctx) return fail();

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Throws if the canvas is tainted — i.e. the storage host didn't send
        // CORS headers. Treated as "no thumbnail", not as an error.
        canvas.toBlob(
          (blob) => {
            cleanup();
            resolve(blob);
          },
          "image/jpeg",
          0.72,
        );
      } catch {
        fail();
      }
    };

    video.onerror = fail;
    video.src = url;
  });
}
