"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ACCEPT, uploadMedia, type MediaKind } from "@/lib/upload";
import { useUploadConsent } from "./UploadConsent";

/**
 * Reads a video URL's own duration in the browser, via a throwaway <video>
 * element rather than any upload/parsing step — the same trick the preview
 * thumbnail above already relies on (`preload="metadata"`), just read
 * programmatically instead of displayed. Works for a Supabase Storage URL
 * (range requests are supported) as well as a freshly uploaded one. Used
 * only to drive this app's own reference-video pricing (see
 * `ModelDef.referenceVideoBilling` in lib/models.ts) — never sent to the
 * provider itself.
 */
function probeVideoDuration(src: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve(v.duration);
    v.onerror = () => reject(new Error("Could not read video duration"));
    v.src = src;
  });
}

/**
 * A single media slot: click to browse, drag a file in, or paste (a file from
 * the clipboard, or a URL as text). Uploads to Supabase Storage and hands the
 * parent back a public URL the provider can fetch.
 */
export default function MediaDrop({
  label,
  hint,
  value,
  onChange,
  kind = "image",
  optional,
  compact,
  disabled,
  disabledHint,
  onDurationChange,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChange: (url: string) => void;
  kind?: MediaKind;
  optional?: boolean;
  compact?: boolean;
  /**
   * Locks the empty drop zone — click, drag-drop and paste all become no-ops,
   * same as the existing consent gate. Only gates the empty state: a slot
   * that already holds a value keeps its Remove button regardless, so
   * clearing an upstream field (e.g. the start frame below) never strands an
   * end frame the user already uploaded with no way to remove it.
   */
  disabled?: boolean;
  /** Shown in place of `hint` while `disabled` and empty. */
  disabledHint?: string;
  /**
   * Reports the clip's own duration (seconds) whenever `value` changes, for
   * `kind === "video"` only — fires with 0 once the slot is cleared. Omit for
   * any video slot that doesn't drive pricing (Kling's flat-rate reference
   * video, start/end frames); only Wan 3.0's additive-billing reference video
   * passes this today.
   */
  onDurationChange?: (seconds: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const { granted, busyKey, setBusyKey } = useUploadConsent();

  // One id per slot instance, stable for the component's lifetime — used to
  // tell "I'm the one uploading" apart from "some other slot is uploading"
  // via the shared busyKey (see UploadConsent.tsx). Two different slots never
  // collide on this even if they render in the same position across a
  // re-render, which a plain counter or the slot's own label could.
  const id = useId();
  const lockedByOtherUpload = busyKey !== null && busyKey !== id;
  // Every place below that used to gate on the parent's `disabled` prop alone
  // now also respects another slot being mid-upload — same reasoning as the
  // parent gate (click/drag/paste become no-ops on an empty slot), just a
  // second reason rather than a new mechanism. Keeps every model's composer
  // down to one upload in flight at a time: start/end frame, the reference
  // video, and every reference image slot (4 for Kling and Wan 2.7, 10 for
  // Wan 3.0) all share the one busyKey from the UploadConsentProvider they
  // sit inside.
  const effectiveDisabled = disabled || lockedByOtherUpload;

  const height = compact ? "h-20" : "h-28";

  async function handle(file: File) {
    // Same reasoning as the consent gate below: enforced server-side too
    // (the parent simply never renders a usable end-frame slot's onChange
    // path without a start frame in practice), but told here so nothing
    // appears to accept a file it will not use.
    if (effectiveDisabled) return;

    // Checked here as well as on the server. Not for security — the server is
    // the only thing that actually enforces it — but so the person is told
    // before their file leaves the machine rather than after a round trip.
    if (!granted) {
      setError("Tick the confirmation above first.");
      return;
    }

    setBusy(true);
    // Claimed for the whole upload, released in `finally` below regardless of
    // outcome — a failed upload must not leave every other slot locked.
    setBusyKey(id);
    setError(null);
    try {
      onChange(await uploadMedia(file, kind, granted));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      setBusyKey(null);
    }
  }

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const onPaste = (e: ClipboardEvent) => {
      if (effectiveDisabled) return;

      const file = Array.from(e.clipboardData?.files ?? [])[0];
      if (file) {
        e.preventDefault();
        void handle(file);
        return;
      }
      const text = e.clipboardData?.getData("text")?.trim();
      if (text && /^https?:\/\//i.test(text)) {
        e.preventDefault();
        // A pasted URL never touches /api/upload/sign, so it would have walked
        // straight past the gate. Same rule, same message.
        if (!granted) {
          setError("Tick the confirmation above first.");
          return;
        }
        onChange(text);
      }
    };

    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
    // Rebinds when consent or either disabled reason changes. The listener
    // closes over all three, so a stale binding would keep accepting (or
    // refusing) pastes after one of them flipped — which is exactly the bug
    // a ref read during render was hiding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granted, effectiveDisabled]);

  // Re-probes on every value change rather than only right after `handle()`
  // uploads a file — that single effect also covers a pasted URL (which
  // never goes through `handle`) and the slot being cleared (reports 0),
  // without duplicating the probe call at each of those sites.
  useEffect(() => {
    if (kind !== "video" || !onDurationChange) return;
    if (!value) {
      onDurationChange(0);
      return;
    }
    let cancelled = false;
    probeVideoDuration(value)
      .then((seconds) => {
        if (!cancelled) onDurationChange(seconds);
      })
      .catch(() => {
        // Left for the server's own fallback (see the generate route) rather
        // than guessed at here — reporting 0 would read as "no reference
        // video" to the pricing math, which is the wrong direction to fail
        // toward for a bill that only ever goes up from an unmeasured video.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, kind]);

  return (
    <div ref={rootRef} tabIndex={-1} className="outline-none">
      {label && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <label className="text-[10px] font-medium uppercase tracking-[0.09em] text-accent-400">
            {label}
          </label>
          {optional && (
            <span className="text-[10px] text-ink-400">optional</span>
          )}
        </div>
      )}

      {value ? (
        <div
          className={`group relative overflow-hidden rounded-lg border border-ink-650 bg-ink-850 ${height}`}
        >
          {kind === "video" ? (
            <video
              src={value}
              muted
              loop
              playsInline
              preload="metadata"
              // play() is async; if the pointer leaves before it resolves,
              // pause() rejects the promise. Harmless, but an unhandled
              // rejection takes over the whole dev overlay.
              onMouseEnter={(e) => {
                void e.currentTarget.play().catch(() => {});
              }}
              onMouseLeave={(e) => e.currentTarget.pause()}
              className="h-full w-full object-cover"
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={value}
              alt={label ?? ""}
              className="h-full w-full object-contain"
              onError={() => setError("That file could not be loaded.")}
            />
          )}
          <button
            type="button"
            onClick={() => {
              onChange("");
              setError(null);
            }}
            className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur transition group-hover:opacity-100"
          >
            Remove
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (effectiveDisabled) return;
            inputRef.current?.click();
          }}
          onDragOver={(e) => {
            if (effectiveDisabled) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            if (effectiveDisabled) return;
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handle(file);
          }}
          disabled={busy || effectiveDisabled}
          aria-disabled={!granted || effectiveDisabled}
          className={`flex ${height} w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed transition ${
            dragging
              ? "border-accent-400 bg-accent-500/20"
              : effectiveDisabled || !granted
                ? "border-ink-650 bg-ink-850 opacity-45"
                : "border-accent-500/35 bg-ink-850 hover:border-accent-500/70 hover:bg-accent-500/[0.07]"
          } ${effectiveDisabled ? "cursor-not-allowed" : ""}`}
        >
          {busy ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-ink-700 border-t-accent-500" />
              <span className="text-[11px] text-ink-400">Uploading…</span>
            </>
          ) : disabled ? (
            <span className="px-2 text-center text-[11px] text-ink-400">
              {disabledHint ?? "Add a start frame first"}
            </span>
          ) : lockedByOtherUpload ? (
            <span className="px-2 text-center text-[11px] text-ink-400">
              Finish the current upload first
            </span>
          ) : (
            <>
              <span className="text-lg leading-none text-accent-400">+</span>
              <span className="text-[11px] text-ink-200">
                {compact ? "Add" : "Click or drop"}
              </span>
              {!compact && (
                <span className="text-[10px] text-ink-400">or paste</span>
              )}
            </>
          )}
        </button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT[kind]}
        disabled={effectiveDisabled}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handle(file);
          e.target.value = "";
        }}
      />

      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}
      {!error && hint && !(effectiveDisabled && !value) && (
        <p className="mt-1.5 text-[11px] text-ink-400">{hint}</p>
      )}
    </div>
  );
}
