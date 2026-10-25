"use client";

import { useEffect, useRef, useState } from "react";
import { uploadMedia } from "@/lib/upload";
import { captureThumbnail } from "@/lib/videoThumbnail";

interface Selection {
  id: string;
  name: string;
  maskUrl: string;
}

interface PendingMask {
  maskUrl: string;
  x: number;
  y: number;
}

/**
 * Point-click object/background selection for one prepared scene clip —
 * Phase 2's hover-to-select step. A representative frame of the clip is
 * captured and uploaded once (fal's segmentation model needs a real URL it
 * can fetch; a blob: URL from the browser doesn't work there), then each
 * click on it is sent to `/api/segment`, which calls fal's SAM 3 and
 * returns a mask image for whatever sits under that point.
 *
 * ChatGPT prompt drafting stays mocked for now (per an earlier explicit
 * choice) — rather than leave selected objects/backgrounds unused, naming
 * each one here builds a short starter prompt listing them, in the same
 * "name it so the model doesn't blend it" style Mic Studio's own composer
 * already uses for reference images.
 */
export default function SceneObjectSelector({
  sourceUrl,
  sourceWidth,
  sourceHeight,
  clipStart,
  clipEnd,
  initialPrompt,
  granted,
  onClose,
  onSave,
}: {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  clipStart: number;
  clipEnd: number;
  initialPrompt: string;
  granted: boolean;
  onClose: () => void;
  onSave: (prompt: string) => void;
}) {
  const nameSeq = useRef(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 960, height: 540 });
  const [loadingFrame, setLoadingFrame] = useState(true);
  const [segmenting, setSegmenting] = useState(false);
  const [pending, setPending] = useState<PendingMask | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [selections, setSelections] = useState<Selection[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function prepareFrame() {
      setLoadingFrame(true);
      setError(null);
      try {
        // Capped at 960px wide and kept at the source's own aspect ratio —
        // stretching to a fixed box would distort the frame fal actually
        // sees, which is otherwise unnecessary: this app's reference clips
        // are already 16:9/9:16/1:1, so the source's own ratio is already
        // one of those.
        const width = 960;
        const height = Math.max(
          1,
          Math.round((width * (sourceHeight || 1)) / (sourceWidth || 1)),
        );
        const dataUrl = await captureThumbnail(
          sourceUrl,
          (clipStart + clipEnd) / 2,
          width,
          height,
        );
        if (!dataUrl) {
          throw new Error(
            "Could not capture a frame from this clip to select from.",
          );
        }
        if (cancelled) return;
        setFrameDataUrl(dataUrl);
        setFrameSize({ width, height });

        const blob = await (await fetch(dataUrl)).blob();
        nameSeq.current += 1;
        const file = new File([blob], `frame-${nameSeq.current}.jpg`, {
          type: "image/jpeg",
        });
        const url = await uploadMedia(file, "image", granted);
        if (cancelled) return;
        setFrameUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Could not prepare this frame.",
          );
        }
      } finally {
        if (!cancelled) setLoadingFrame(false);
      }
    }

    void prepareFrame();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, clipStart, clipEnd]);

  async function handleFrameClick(e: React.MouseEvent<HTMLImageElement>) {
    if (!frameUrl || segmenting) return;
    const img = imgRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const x = Math.round(relX * frameSize.width);
    const y = Math.round(relY * frameSize.height);

    setSegmenting(true);
    setError(null);
    setPending(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, x, y }),
      });
      const json = (await res.json()) as { maskUrl?: string; error?: string };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? "Could not detect anything there.");
      }
      setPending({ maskUrl: json.maskUrl, x, y });
      setPendingName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not detect anything there.");
    } finally {
      setSegmenting(false);
    }
  }

  function keepPending() {
    if (!pending) return;
    nameSeq.current += 1;
    setSelections((prev) => [
      ...prev,
      {
        id: `sel-${nameSeq.current}`,
        name: pendingName.trim() || `Selection ${prev.length + 1}`,
        maskUrl: pending.maskUrl,
      },
    ]);
    setPending(null);
    setPendingName("");
  }

  function removeSelection(id: string) {
    setSelections((prev) => prev.filter((s) => s.id !== id));
  }

  function handleDone() {
    if (selections.length === 0) {
      onClose();
      return;
    }
    const names = selections.map((s) => s.name);
    const keepLine =
      names.length === 1
        ? `Keep "${names[0]}" unchanged throughout.`
        : `Keep these unchanged throughout: ${names.map((n) => `"${n}"`).join(", ")}.`;
    const prompt = initialPrompt
      ? `${keepLine} ${initialPrompt}`
      : `${keepLine} Describe what happens to the rest of the scene here.`;
    onSave(prompt);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-ink-650 bg-ink-900 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">
            Select objects &amp; backgrounds
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-ink-400 hover:text-white"
          >
            Close
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-ink-400">
          Click a person, object, or background in the frame below to detect
          it, then give it a short name. Named selections get listed in the
          prompt so the model knows to keep them unchanged.
        </p>

        {loadingFrame && (
          <div className="flex h-48 items-center justify-center text-xs text-ink-400">
            Preparing a frame from this clip…
          </div>
        )}

        {frameDataUrl && (
          <div className="relative overflow-hidden rounded-lg border border-ink-650 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={frameDataUrl}
              alt=""
              onClick={(e) => void handleFrameClick(e)}
              className={`block w-full ${
                frameUrl && !segmenting ? "cursor-crosshair" : "cursor-wait"
              }`}
            />
            {pending && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pending.maskUrl}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-60 mix-blend-screen"
              />
            )}
            {segmenting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
                Detecting…
              </div>
            )}
          </div>
        )}

        {pending && (
          <div className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/[0.08] px-3 py-2">
            <input
              type="text"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              placeholder="Name this selection — e.g. “the jacket”"
              className="flex-1 rounded-md border border-ink-650 bg-ink-900 px-2 py-1 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
              autoFocus
            />
            <button
              type="button"
              onClick={keepPending}
              className="shrink-0 rounded-md bg-accent-500 px-2.5 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-400"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="shrink-0 text-xs text-ink-400 hover:text-white"
            >
              Discard
            </button>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        {selections.length > 0 && (
          <ul className="space-y-1.5">
            {selections.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-ink-650 bg-ink-850 px-3 py-1.5 text-xs text-ink-200"
              >
                <span className="truncate">{s.name}</span>
                <button
                  type="button"
                  onClick={() => removeSelection(s.id)}
                  className="shrink-0 text-ink-400 hover:text-white"
                  aria-label={`Remove ${s.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={handleDone}
          className="w-full rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-400"
        >
          {selections.length > 0
            ? `Done — add ${selections.length} to prompt`
            : "Done"}
        </button>
      </div>
    </div>
  );
}
