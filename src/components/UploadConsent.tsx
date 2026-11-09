"use client";

import { createContext, useContext, useState } from "react";
import Link from "next/link";
import { CONSENT_HINT, CONSENT_TEXT } from "@/lib/consent";

/**
 * One consent, shared by every upload slot on screen.
 *
 * A checkbox per slot would be honest and unusable — image-to-video has two
 * frames, and reference mode has a video plus four images, so a careful person
 * would tick the same sentence six times for one clip. Consent is per session
 * of use, and the record written server-side is per file, which is the right
 * way round: the person affirms once, the log stays complete.
 *
 * Deliberately not persisted. It resets on reload, because a box that
 * remembers itself from last week is a box nobody read.
 */

interface ConsentValue {
  granted: boolean;
  setGranted: (v: boolean) => void;
  /**
   * The id of whichever MediaDrop slot is mid-upload, or null when nothing
   * is uploading. Shared across every slot inside one UploadConsentProvider
   * — start/end frame, the video reference, and every image reference slot
   * — so only one upload can run at a time per model, not just per slot.
   * Applies the same way to every model: this lives above ReferencePanel's
   * per-model branching, so Kling's four reference images, Wan 3.0's ten,
   * and the video dropzone any of them might show are all one shared lock.
   * MediaDrop claims it in `handle()` and releases it when the upload
   * settles; every other slot reads it to disable its own empty state in
   * the meantime (see MediaDrop's `effectiveDisabled`).
   */
  busyKey: string | null;
  setBusyKey: (key: string | null) => void;
}

const Ctx = createContext<ConsentValue>({
  granted: false,
  setGranted: () => {},
  busyKey: null,
  setBusyKey: () => {},
});

export function UploadConsentProvider({
  children,
  defaultGranted = false,
}: {
  children: React.ReactNode;
  /**
   * Seeds `granted` as already true — for the one case where that's honest
   * rather than a shortcut: this composer's reference video/images all
   * arrived via the Reference Editor hand-off, which already showed this
   * same checkbox for these exact files and couldn't have uploaded them
   * without it (/api/upload/sign refuses without consent). Still a normal,
   * untruncated boolean the person can switch back off — this only changes
   * where it starts, never what it enforces.
   */
  defaultGranted?: boolean;
}) {
  const [granted, setGranted] = useState(defaultGranted);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  return (
    <Ctx.Provider value={{ granted, setGranted, busyKey, setBusyKey }}>
      {children}
    </Ctx.Provider>
  );
}

export function useUploadConsent() {
  return useContext(Ctx);
}

/**
 * The control itself.
 *
 * Rendered above the upload slots rather than below them, so it is read before
 * the file is chosen rather than discovered after. It turns lime once ticked —
 * the same affordance as a selected option elsewhere in the composer, so it
 * reads as a setting rather than a warning.
 */
export default function ConsentCheckbox({
  collapsedByDefault = false,
}: {
  /**
   * Starts as a single confirmed line ("Upload consent confirmed ·
   * Review") instead of the full sentence-plus-checkbox — for the one case
   * where the full text was already read and ticked moments earlier in the
   * same session (see UploadConsentProvider's `defaultGranted`), so showing
   * it again in full would just be the same sentence twice in one sitting.
   * "Review" expands it back to the normal control, still live either way
   * — collapsing is purely about what's on screen first, never about
   * weakening the consent itself, and it never collapses on its own if the
   * person un-ticks it after expanding.
   */
  collapsedByDefault?: boolean;
}) {
  const { granted, setGranted } = useUploadConsent();
  const [expanded, setExpanded] = useState(!collapsedByDefault);

  if (!expanded) {
    return (
      <div className="flex items-center justify-between gap-2.5 rounded-lg border border-accent-500/45 bg-accent-500/[0.07] px-2.5 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-200">
          <span aria-hidden className="text-accent-400">
            ✓
          </span>
          Upload consent confirmed in the Reference Editor
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 text-[11px] text-accent-400 underline underline-offset-2 hover:text-white"
        >
          Review
        </button>
      </div>
    );
  }

  return (
    <label
      className={`flex cursor-pointer gap-2.5 rounded-lg border p-2.5 transition ${
        granted
          ? "border-accent-500/45 bg-accent-500/[0.07]"
          : "border-ink-650 bg-ink-850 hover:border-ink-600"
      }`}
    >
      <input
        type="checkbox"
        checked={granted}
        onChange={(e) => setGranted(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent-500)]"
      />
      <span className="min-w-0">
        <span className="block text-[11px] leading-snug text-ink-200">
          {CONSENT_TEXT}
        </span>
        <span className="mt-1 block text-[10px] leading-snug text-ink-400">
          {CONSENT_HINT}{" "}
          <Link
            href="/terms"
            target="_blank"
            className="text-accent-400 underline underline-offset-2 hover:text-white"
          >
            Terms
          </Link>
        </span>
      </span>
    </label>
  );
}
