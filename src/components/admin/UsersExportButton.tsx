"use client";

import { useState } from "react";

/**
 * Same "Download report (.csv)" pattern as RetentionCleanupPanel's export
 * link — hits a route that regenerates the CSV and hands back a short-lived
 * signed URL, then opens it in a new tab so the browser's own download flow
 * takes over. Kept separate from that panel's button since this one exports
 * a different table (every account) to a different route.
 */
export default function UsersExportButton() {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  async function download() {
    setState("loading");
    try {
      const res = await fetch("/api/admin/users/export");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      window.open(body.url as string, "_blank", "noopener,noreferrer");
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => void download()}
        disabled={state === "loading"}
        className="text-xs text-accent-400 underline underline-offset-2 transition hover:text-white disabled:opacity-50"
      >
        {state === "loading" ? "Preparing…" : "Download report (.csv)"}
      </button>
      {state === "error" && (
        <span className="text-[11px] text-red-300">
          Couldn&apos;t prepare the report — try again.
        </span>
      )}
    </div>
  );
}
