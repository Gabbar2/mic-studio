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
  name: string;
}

/**
 * Describe-to-select object/background selection for one prepared scene
 * clip — Phase 2's select-to-keep step. A representative frame of the clip
 * is captured and uploaded once (fal's segmentation model needs a real URL
 * it can fetch; a blob: URL from the browser doesn't work there).
 *
 * Describing what to select, not clicking it: SAM 3 is a *text-concept*
 * segmentation model, not classic click-anywhere SAM — a point alone, with
 * no description, silently fell back to fal's own default search concept
 * and never found anything on a real frame. Typing a short phrase ("the red
 * jacket", "the dog") is both what the model actually needs and, usefully,
 * doubles as the selection's name — no separate naming step after the fact.
 *
 * ChatGPT prompt drafting stays mocked for now (per an earlier explicit
 * choice) — rather than leave selected objects/backgrounds unused, the list
 * of kept descriptions builds a short starter prompt, in the same "name it
 * so the model doesn't blend it" style Mic Studio's own composer already
 * uses for reference images.
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

  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(true);
  const [describeText, setDescribeText] = useState("");
  const [segmenting, setSegmenting] = useState(false);
  const [pending, setPending] = useState<PendingMask | null>(null);
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

  async function handleDetect() {
    const text = describeText.trim();
    if (!frameUrl || !text || segmenting) return;

    setSegmenting(true);
    setError(null);
    setPending(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, prompt: text }),
      });
      const json = (await res.json()) as { maskUrl?: string; error?: string };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? "Could not detect that.");
      }
      setPending({ maskUrl: json.maskUrl, name: text });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not detect that.");
    } finally {
      setSegmenting(false);
    }
  }

  function keepPending() {
    if (!pending) return;
    nameSeq.current += 1;
    setSelections((prev) => [
      ...prev,
      { id: `sel-${nameSeq.current}`, name: pending.name, maskUrl: pending.maskUrl },
    ]);
    setPending(null);
    setDescribeText("");
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
          Describe a person, object, or background in the frame below — e.g.
          &quot;the red jacket&quot; or &quot;the background wall&quot; —
          then press Detect. Keep the ones you want preserved; they get
          listed in the prompt so the model doesn&apos;t blend them away.
        </p>

        {loadingFrame && (
          <div className="flex h-48 items-center justify-center text-xs text-ink-400">
            Preparing a frame from this clip…
          </div>
        )}

        {frameDataUrl && (
          <div className="relative flex max-h-[45vh] items-center justify-center overflow-hidden rounded-lg border border-ink-650 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={frameDataUrl}
              alt=""
              className="max-h-[45vh] w-auto max-w-full object-contain"
            />
            {pending && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pending.maskUrl}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-60 mix-blend-screen"
              />
            )}
            {segmenting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
                Detecting…
              </div>
            )}
          </div>
        )}

        {!pending && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={describeText}
              onChange={(e) => setDescribeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleDetect();
              }}
              placeholder="What do you want to select? e.g. “the dog”"
              disabled={!frameUrl || segmenting}
              className="flex-1 rounded-md border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void handleDetect()}
              disabled={!frameUrl || !describeText.trim() || segmenting}
              className="shrink-0 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
            >
              Detect
            </button>
          </div>
        )}

        {pending && (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-accent-500/30 bg-accent-500/[0.08] px-3 py-2">
            <span className="text-xs text-ink-200">
              Found <span className="text-white">“{pending.name}”</span> —
              keep it?
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={keepPending}
                className="rounded-md bg-accent-500 px-2.5 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-400"
              >
                Keep
              </button>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="text-xs text-ink-400 hover:text-white"
              >
                Discard
              </button>
            </div>
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
