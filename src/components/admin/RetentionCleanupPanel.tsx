"use client";

import { useEffect, useState } from "react";

interface ReadyNotice {
  id: string;
  user_id: string;
  email: string;
  deadline: string;
  template_key: string;
  clip_count_at_send: number;
  sent_at: string;
}

type CleanupResult = {
  cleaned: number;
  skipped: number;
  totalClipsDeleted: number;
};

/**
 * The one place in /admin that actually deletes customer media. Separate
 * component, separate section, separate confirmation — a notice only shows
 * up here once its deadline has already passed (the server re-checks this
 * too; see the cleanup route), and nothing is removed until the admin picks
 * specific rows and clicks through a native confirm() on top of that.
 */
export default function RetentionCleanupPanel() {
  const [notices, setNotices] = useState<ReadyNotice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [exportState, setExportState] = useState<
    "idle" | "loading" | "error"
  >("idle");

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/retention/ready");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setNotices(body.notices as ReadyNotice[]);
      setSelected(new Set());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load");
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount — load() owns its own error handling and this
    // page has no subscription to tear down, so there's nothing for a
    // cleanup function to cancel here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runCleanup() {
    if (selected.size === 0) return;
    const ok = window.confirm(
      `Permanently delete stored clips for ${selected.size} account${
        selected.size === 1 ? "" : "s"
      }? This cannot be undone.`,
    );
    if (!ok) return;

    setCleaning(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/retention/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noticeIds: Array.from(selected) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      setResult(body as CleanupResult);
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Cleanup failed");
    } finally {
      setCleaning(false);
    }
  }

  async function downloadReport() {
    setExportState("loading");
    try {
      const res = await fetch("/api/admin/retention/export");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
      window.open(body.url as string, "_blank", "noopener,noreferrer");
      setExportState("idle");
    } catch {
      setExportState("error");
    }
  }

  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          Retention cleanup
        </h2>
        <button
          onClick={downloadReport}
          disabled={exportState === "loading"}
          className="text-xs text-accent-400 underline underline-offset-2 transition hover:text-white disabled:opacity-50"
        >
          {exportState === "loading" ? "Preparing…" : "Download report (.csv)"}
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-400">
        Accounts whose retention-notice deadline has passed and are not yet
        cleaned up. Nothing here is deleted until you select rows and
        confirm below.
      </p>
      {exportState === "error" && (
        <p className="mt-2 text-xs text-red-300">
          Couldn&apos;t prepare the report — try again in a moment.
        </p>
      )}

      {loadError && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {loadError}
        </p>
      )}

      {result && (
        <p className="mt-3 rounded-lg border border-accent-500/30 bg-accent-500/[0.06] px-3 py-2 text-xs text-ink-200">
          Cleaned {result.cleaned} account{result.cleaned === 1 ? "" : "s"} —{" "}
          {result.totalClipsDeleted} clip
          {result.totalClipsDeleted === 1 ? "" : "s"} deleted.
        </p>
      )}

      {notices === null ? (
        <p className="mt-4 text-xs text-ink-400">Loading…</p>
      ) : notices.length === 0 ? (
        <p className="mt-4 text-xs text-ink-400">
          Nothing is due for cleanup right now.
        </p>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2.5">
              <span className="text-xs text-ink-200">
                {selected.size} selected
              </span>
              <button
                onClick={runCleanup}
                disabled={cleaning}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {cleaning ? "Deleting…" : `Delete stored clips for ${selected.size} →`}
              </button>
            </div>
          )}

          <div className="mt-3 overflow-x-auto rounded-xl border border-ink-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-ink-800 bg-ink-900/60">
                  <th className="w-8 px-3 py-2.5" />
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Email
                  </th>
                  <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Deadline
                  </th>
                  <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                    Clips at send
                  </th>
                </tr>
              </thead>
              <tbody>
                {notices.map((n) => (
                  <tr
                    key={n.id}
                    className="border-b border-ink-800/70 last:border-0 hover:bg-ink-900/40"
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(n.id)}
                        onChange={() => toggle(n.id)}
                        aria-label={`Select ${n.email}`}
                        className="h-3.5 w-3.5 accent-red-500"
                      />
                    </td>
                    <td className="px-3 py-2.5 text-ink-200">{n.email}</td>
                    <td className="px-3 py-2.5 text-ink-400">{n.deadline}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-200">
                      {n.clip_count_at_send}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
