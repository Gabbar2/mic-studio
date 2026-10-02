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
}

const Ctx = createContext<ConsentValue>({
  granted: false,
  setGranted: () => {},
});

export function UploadConsentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [granted, setGranted] = useState(false);
  return <Ctx.Provider value={{ granted, setGranted }}>{children}</Ctx.Provider>;
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
export default function ConsentCheckbox() {
  const { granted, setGranted } = useUploadConsent();

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
