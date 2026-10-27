"use client";

import { useEffect, useRef, useState } from "react";
import { uploadMedia } from "@/lib/upload";
import { captureThumbnail } from "@/lib/videoThumbnail";

interface Selection {
  id: string;
  name: string;
  maskUrl: string;
  color: string;
}

interface PendingMask {
  maskUrl: string;
  name: string;
}

/**
 * Distinct, colorblind-friendlyish hues so several kept selections read as
 * separate highlights at a glance rather than one blob. Cycles if there are
 * more selections than colors — unlikely for a handful of kept objects per
 * clip, and a repeat is harmless (the name label still disambiguates).
 */
const HIGHLIGHT_COLORS = [
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#facc15", // yellow
  "#a78bfa", // violet
  "#fb923c", // orange
  "#4ade80", // green
];

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
  const [candidates, setCandidates] = useState<string[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [pillBusy, setPillBusy] = useState<string | null>(null);
  const nextColor = (count: number) =>
    HIGHLIGHT_COLORS[count % HIGHLIGHT_COLORS.length];

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

  // Auto-detect pills: a best-effort suggestion list, so most of the time
  // nobody has to type a description from scratch at all. Deliberately
  // separate from the frame-prep effect above and from the blocking `error`
  // state — Florence-2 having a bad moment, or finding nothing, should never
  // stop the rest of the selector from working; it just means the pill row
  // stays empty and manual typing is still right there.
  useEffect(() => {
    if (!frameUrl) return;
    let cancelled = false;

    (async () => {
      setLoadingCandidates(true);
      setCandidates([]);
      try {
        const res = await fetch("/api/detect-labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: frameUrl }),
        });
        const json = (await res.json()) as { labels?: unknown };
        if (!cancelled && res.ok && Array.isArray(json.labels)) {
          setCandidates(json.labels.filter((l): l is string => typeof l === "string"));
        }
      } catch {
        // Best-effort — see comment above.
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

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
      {
        id: `sel-${nameSeq.current}`,
        name: pending.name,
        maskUrl: pending.maskUrl,
        color: nextColor(prev.length),
      },
    ]);
    setPending(null);
    setDescribeText("");
  }

  function removeSelection(id: string) {
    setSelections((prev) => prev.filter((s) => s.id !== id));
  }

  function selectionForLabel(label: string) {
    const needle = label.trim().toLowerCase();
    return selections.find((s) => s.name.trim().toLowerCase() === needle);
  }

  /**
   * One click on an auto-detected pill either adds or removes it — unlike
   * the manual-typing path, there's no "Found X — keep it?" confirmation
   * step here, since Florence-2 already named the object before the pill
   * ever appeared; SAM 3 is only asked to turn that name into a mask.
   */
  async function addByLabel(label: string) {
    const existing = selectionForLabel(label);
    if (existing) {
      removeSelection(existing.id);
      return;
    }
    if (!frameUrl || pillBusy) return;

    setPillBusy(label);
    setError(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, prompt: label }),
      });
      const json = (await res.json()) as { maskUrl?: string; error?: string };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? `Could not detect "${label}".`);
      }
      nameSeq.current += 1;
      setSelections((prev) => [
        ...prev,
        {
          id: `sel-${nameSeq.current}`,
          name: label,
          maskUrl: json.maskUrl!,
          color: nextColor(prev.length),
        },
      ]);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : `Could not detect "${label}".`,
      );
    } finally {
      setPillBusy(null);
    }
  }

  // Wrapped defensively: onSave ultimately runs the parent's state update
  // and closes this modal, so if anything in that chain throws, the only
  // sign would otherwise be the modal silently staying open with the click
  // appearing to do nothing — worth surfacing instead of swallowing.
  function handleDone() {
    try {
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
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not save: ${e.message}`
          : "Could not save these selections — try again.",
      );
    }
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
          Tap a suggested object below the frame to add it, or describe
          anything else — e.g. &quot;the red jacket&quot; or &quot;the
          background wall&quot; — and press Detect. Each kept selection stays
          highlighted in its own color so you can see everything you&apos;ve
          kept at once, and gets listed in the prompt so the model
          doesn&apos;t blend it away.
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
            {/*
             * Every kept selection stays highlighted on the frame, not just
             * the one currently being detected — this is the closest this
             * text-concept model can get to a true hover/long-press
             * highlight (SAM 3 has no cheap per-pixel "what's under the
             * cursor" query; each highlight here is the result of an actual
             * billed detection call, not a live probe). Tinted with
             * mask-image/background-color rather than mix-blend-screen so
             * several selections read as distinct colors instead of
             * stacking into one white blob.
             */}
            {selections.map((s) => (
              <div
                key={s.id}
                className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
                style={{
                  backgroundColor: s.color,
                  WebkitMaskImage: `url(${s.maskUrl})`,
                  maskImage: `url(${s.maskUrl})`,
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                }}
              />
            ))}
            {pending && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={pending.maskUrl}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full animate-pulse object-contain opacity-70 mix-blend-screen"
              />
            )}
            {segmenting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
                Detecting…
              </div>
            )}
          </div>
        )}

        {frameUrl && (loadingCandidates || candidates.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {loadingCandidates && candidates.length === 0 && (
              <span className="text-[11px] text-ink-500">
                Finding objects…
              </span>
            )}
            {candidates.map((label) => {
              const sel = selectionForLabel(label);
              const busy = pillBusy === label;
              return (
                <button
                  key={label}
                  type="button"
                  onClick={() => void addByLabel(label)}
                  disabled={busy}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-wait disabled:opacity-60 ${
                    sel
                      ? "border-transparent text-white"
                      : "border-ink-650 bg-ink-850 text-ink-200 hover:border-ink-500"
                  }`}
                  style={sel ? { backgroundColor: `${sel.color}33` } : undefined}
                >
                  {sel && (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: sel.color }}
                      aria-hidden
                    />
                  )}
                  {busy ? "Detecting…" : label}
                </button>
              );
            })}
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
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.color }}
                    aria-hidden
                  />
                  <span className="truncate">{s.name}</span>
                </span>
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
