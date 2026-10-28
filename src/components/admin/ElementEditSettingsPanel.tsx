"use client";

import { useEffect, useState } from "react";

/**
 * The one switch that controls real spend in the per-element AI edit
 * feature (the ✨ chat in the Reference Editor's object selector). Starts
 * in mock mode on every fresh deploy — see 0021_app_settings.sql and
 * lib/elementEditSettings.ts — so this page is where an admin makes the
 * deliberate decision to start calling OpenAI for real.
 */
export default function ElementEditSettingsPanel() {
  const [mock, setMock] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/element-edit-settings");
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Could not load");
        setMock(body.mock as boolean);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load");
      }
    })();
  }, []);

  async function toggle() {
    if (mock === null || saving) return;
    const next = !mock;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/element-edit-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mock: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "Could not save");
      setMock(body.mock as boolean);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const isLive = mock === false;

  return (
    <div className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight text-white">
        Element edit — AI image generation
      </h2>
      <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-ink-400">
        Controls the ✨ chat in the Reference Editor&apos;s object selector.
        Mock mode costs nothing — it hands back the original frame
        unchanged, clearly labeled, so the whole flow (send, generate,
        Continue in Mic Studio) can be tested end to end with no OpenAI
        charge. Turning this on calls OpenAI&apos;s real image-edit API —
        roughly a few cents per edit, billed to whatever{" "}
        <code className="rounded bg-ink-850 px-1 py-0.5 text-[10px]">
          OPENAI_API_KEY
        </code>{" "}
        is set in this app&apos;s environment variables.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
        <button
          type="button"
          role="switch"
          aria-checked={isLive}
          aria-label="Toggle real OpenAI image generation"
          onClick={() => void toggle()}
          disabled={mock === null || saving}
          className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:cursor-wait disabled:opacity-60 ${
            isLive ? "bg-accent-500" : "bg-ink-700"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${
              isLive ? "left-5" : "left-0.5"
            }`}
          />
        </button>
        <div className="text-xs">
          <p className="font-medium text-white">
            {mock === null
              ? "Loading…"
              : isLive
                ? "Live — calling OpenAI for real"
                : "Mock mode — no real edits, no cost"}
          </p>
          <p className="text-ink-400">
            {mock === null
              ? ""
              : isLive
                ? "Every ✨ edit now costs real money."
                : "Flip this on when you're ready to start spending real OpenAI credits."}
          </p>
        </div>
      </div>
    </div>
  );
}
