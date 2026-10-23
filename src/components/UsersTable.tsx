"use client";

import { useState } from "react";
import Link from "next/link";
import { creditLabel } from "@/lib/pricing";
import { RETENTION_TEMPLATES } from "@/lib/retentionEmailTemplates";

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  joinedAt: string;
  lastSeenAt: string | null;
  confirmed: boolean;
  clips: number;
  creditsLeftCents: number;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Today + 7 days, as "YYYY-MM-DD" — a sane default deadline rather than an
 * empty date field the admin has to fill in every time. */
function defaultDeadline(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

type SendResult = {
  sent: number;
  failed: number;
  skipped: number;
  results: { userId: string; email: string | null; status: string; error?: string }[];
};

/**
 * The Users table, now with a checkbox per row and a bulk "retention
 * notice" flow (pick a template → pick a deadline → review → send) — the
 * server routes under /api/admin/retention do the actual emailing and,
 * later, deletion. This component only ever asks for an email to go out;
 * it has no path that deletes anything (see RetentionCleanupPanel for the
 * separate, manually-confirmed step that does).
 */
export default function UsersTable({ rows }: { rows: AdminUserRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [step, setStep] = useState<"template" | "deadline" | "review">(
    "template",
  );
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openPanel() {
    setStep("template");
    setResult(null);
    setError(null);
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
    if (result && result.failed === 0) setSelected(new Set());
  }

  async function send() {
    if (!templateKey) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/retention/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: Array.from(selected),
          templateKey,
          deadline,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? `Request failed (${res.status})`);
        return;
      }
      setResult(body as SendResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSending(false);
    }
  }

  const selectedTemplate = RETENTION_TEMPLATES.find(
    (t) => t.key === templateKey,
  );

  return (
    <div>
      {selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-accent-500/30 bg-accent-500/[0.06] px-3 py-2.5">
          <span className="text-xs text-ink-200">
            {selected.size} account{selected.size === 1 ? "" : "s"} selected
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-ink-400 transition hover:text-white"
            >
              Clear
            </button>
            <button
              onClick={openPanel}
              className="rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-ink transition hover:bg-accent-400"
            >
              Send retention notice →
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink-800">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-ink-800 bg-ink-900/60">
              <th className="w-8 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                  className="h-3.5 w-3.5 accent-accent-500"
                />
              </th>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Email
              </th>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Joined
              </th>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Last seen
              </th>
              <th className="px-3 py-2.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Confirmed
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Clips
              </th>
              <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                Credits
              </th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="border-b border-ink-800/70 last:border-0 hover:bg-ink-900/40"
              >
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleOne(r.id)}
                    aria-label={`Select ${r.email}`}
                    className="h-3.5 w-3.5 accent-accent-500"
                  />
                </td>
                <td className="px-3 py-2.5 text-ink-200">
                  {r.email}
                  {r.isAdmin && (
                    <span className="ml-2 rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400">
                      Admin
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-ink-400">{fmt(r.joinedAt)}</td>
                <td className="px-3 py-2.5 text-ink-400">
                  {fmt(r.lastSeenAt)}
                </td>
                <td className="px-3 py-2.5 text-center">
                  {r.confirmed ? (
                    <span className="text-accent-400">✓</span>
                  ) : (
                    <span className="text-ink-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-200">
                  {r.clips}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-200">
                  {creditLabel(r.creditsLeftCents)}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link
                    href={`/admin/users/${r.id}`}
                    className="text-xs text-accent-400 underline underline-offset-2 transition hover:text-white"
                  >
                    View clips
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {panelOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={closePanel}
        >
          <div
            className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Retention notice — {selected.size} account
                {selected.size === 1 ? "" : "s"}
              </h2>
              <button
                onClick={closePanel}
                className="text-ink-400 transition hover:text-white"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {result ? (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-ink-200">
                  <span className="text-accent-400">{result.sent} sent</span>
                  {result.failed > 0 && (
                    <span className="text-red-400"> · {result.failed} failed</span>
                  )}
                  {result.skipped > 0 && (
                    <span className="text-ink-400">
                      {" "}
                      · {result.skipped} skipped (no email on file)
                    </span>
                  )}
                </p>
                {result.failed > 0 && (
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[11px] text-red-300">
                    {result.results
                      .filter((r) => r.status === "failed")
                      .map((r) => (
                        <div key={r.userId}>
                          {r.email}: {r.error}
                        </div>
                      ))}
                  </div>
                )}
                <button
                  onClick={closePanel}
                  className="w-full rounded-lg bg-ink-700 px-3 py-2 text-xs font-medium text-white transition hover:bg-ink-650"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {step === "template" && (
                  <div className="mt-4 space-y-2">
                    {RETENTION_TEMPLATES.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setTemplateKey(t.key)}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                          templateKey === t.key
                            ? "border-accent-400 bg-accent-500/10"
                            : "border-ink-700 hover:border-ink-600"
                        }`}
                      >
                        <div className="text-xs font-medium text-white">
                          {t.label}
                        </div>
                        <div className="mt-0.5 text-[11px] text-ink-400">
                          {t.description}
                        </div>
                      </button>
                    ))}
                    <button
                      disabled={!templateKey}
                      onClick={() => setStep("deadline")}
                      className="mt-2 w-full rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-accent-ink transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
                    >
                      Next: pick a deadline →
                    </button>
                  </div>
                )}

                {step === "deadline" && (
                  <div className="mt-4 space-y-3">
                    <label className="block text-xs text-ink-300">
                      Deadline shown in the email — after this date you can
                      confirm deletion of their stored clips from the
                      Retention cleanup section below.
                    </label>
                    <input
                      type="date"
                      value={deadline}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setDeadline(e.target.value)}
                      className="w-full rounded-lg border border-ink-650 bg-ink-850 px-3 py-2 text-sm text-white"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setStep("template")}
                        className="flex-1 rounded-lg border border-ink-650 px-3 py-2 text-xs text-ink-200 transition hover:border-ink-500"
                      >
                        ← Back
                      </button>
                      <button
                        onClick={() => setStep("review")}
                        className="flex-1 rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-accent-ink transition hover:bg-accent-400"
                      >
                        Next: review →
                      </button>
                    </div>
                  </div>
                )}

                {step === "review" && (
                  <div className="mt-4 space-y-3">
                    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3 text-xs text-ink-200">
                      <p>
                        <span className="text-ink-400">Template:</span>{" "}
                        {selectedTemplate?.label}
                      </p>
                      <p className="mt-1">
                        <span className="text-ink-400">Deadline:</span>{" "}
                        {deadline}
                      </p>
                      <p className="mt-1">
                        <span className="text-ink-400">Recipients:</span>{" "}
                        {selected.size}
                      </p>
                    </div>
                    <p className="text-[11px] leading-relaxed text-ink-400">
                      Each account gets links to its own stored clips and
                      this deadline. Nothing is deleted by sending this —
                      deletion only happens later, from the Retention
                      cleanup section, and only after you confirm it there.
                    </p>
                    {error && (
                      <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {error}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => setStep("deadline")}
                        disabled={sending}
                        className="flex-1 rounded-lg border border-ink-650 px-3 py-2 text-xs text-ink-200 transition hover:border-ink-500 disabled:opacity-50"
                      >
                        ← Back
                      </button>
                      <button
                        onClick={send}
                        disabled={sending}
                        className="flex-1 rounded-lg bg-accent-500 px-3 py-2 text-xs font-semibold text-accent-ink transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {sending ? "Sending…" : `Send to ${selected.size} →`}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
