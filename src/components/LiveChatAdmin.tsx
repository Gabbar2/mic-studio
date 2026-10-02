"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHAT_POLL_MS,
  PRESENCE_POLL_MS,
  type ChatMessageRow,
  type LiveVisitor,
  type VisitorTier,
} from "@/lib/presence";

const TIER_LABEL: Record<VisitorTier, string> = {
  trial: "Trial",
  free: "Free",
  unlocked: "Unlocked",
};

const TIER_CLASS: Record<VisitorTier, string> = {
  trial: "bg-ink-700 text-ink-200",
  free: "bg-sky-500/15 text-sky-300",
  unlocked: "bg-accent-500/15 text-accent-400",
};

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

/**
 * The admin side of live chat: who's online right now, and a thread per
 * visitor. Polls rather than pushing — see lib/presence.ts for why — so
 * "live" here means "refreshes every few seconds", which is the right
 * amount of real-time for a support inbox, not a reason to add a second
 * delivery mechanism this file would have to maintain on top of the first.
 *
 * Only shows visitors currently online (see ONLINE_WINDOW_SECONDS). A
 * thread with someone who has since gone offline still works — sending
 * into it is just sending into chat_messages, same as any other message —
 * but this view's left column exists specifically to answer "who is here
 * right now", not as a full support inbox of every conversation ever
 * started. That's a deliberate scope line, not a missing feature: if it's
 * ever needed, a user's past chat history would read naturally from the
 * same chat_messages table on their admin detail page.
 */
export default function LiveChatAdmin() {
  const [visitors, setVisitors] = useState<LiveVisitor[]>([]);
  const [selected, setSelected] = useState<LiveVisitor | null>(null);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Tracks the selected visitor outside React state so refreshVisitors can
  // read it without becoming a dependency that tears down and rebuilds the
  // polling interval every time the selection changes.
  const selectedIdRef = useRef<string | null>(null);

  function selectVisitor(v: LiveVisitor) {
    selectedIdRef.current = v.userId;
    setSelected(v);
  }

  const refreshVisitors = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/presence");
      if (!res.ok) return;
      const data = await res.json();
      const list: LiveVisitor[] = data.visitors ?? [];
      setVisitors(list);

      // A visitor that goes offline mid-chat stays selected (their thread
      // doesn't vanish — see the component doc comment), but while they're
      // still in the list this keeps the badge/tier shown for them fresh,
      // folded into the same fetch that produced the new data rather than a
      // separate effect reacting to it.
      const id = selectedIdRef.current;
      if (id) {
        const fresh = list.find((v) => v.userId === id);
        if (fresh) setSelected(fresh);
      }
    } catch {
      // Transient — the next poll retries.
    }
  }, []);

  const refreshThread = useCallback(async (userId: string) => {
    try {
      const res = await fetch(`/api/admin/chat/${userId}`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages ?? []);
    } catch {
      // Transient — the next poll retries.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled && !document.hidden) void refreshVisitors();
    };
    tick();
    const id = setInterval(tick, PRESENCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshVisitors]);

  // Depends on the id, not the whole `selected` object — refreshVisitors
  // above can replace that object (same visitor, fresher data) every few
  // seconds, and keying off the object itself would restart this interval
  // just as often instead of running on its own steady cadence.
  const selectedUserId = selected?.userId ?? null;
  useEffect(() => {
    if (!selectedUserId) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled && !document.hidden) void refreshThread(selectedUserId);
    };
    tick();
    const id = setInterval(tick, CHAT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [selectedUserId, refreshThread]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function handleSend() {
    if (!selected) return;
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/chat/${selected.userId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Couldn't send that — try again.");
        return;
      }
      setDraft("");
      await refreshThread(selected.userId);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[18rem_1fr]">
      <div className="rounded-xl border border-ink-700 bg-ink-900/60">
        <div className="flex items-baseline justify-between border-b border-ink-800 px-3 py-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
            Online now
          </span>
          <span className="text-[11px] tabular-nums text-ink-500">
            {visitors.length}
          </span>
        </div>

        {visitors.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-ink-500">
            Nobody&rsquo;s on the site right now.
          </p>
        ) : (
          <ul className="max-h-[32rem] divide-y divide-ink-800 overflow-y-auto">
            {visitors.map((v) => (
              <li key={v.userId}>
                <button
                  type="button"
                  onClick={() => selectVisitor(v)}
                  className={`block w-full px-3 py-2.5 text-left transition hover:bg-ink-850 ${
                    selected?.userId === v.userId ? "bg-ink-850" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] text-ink-100">
                      {v.email ?? "Anonymous visitor"}
                    </span>
                    {v.unreadCount > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
                        {v.unreadCount > 9 ? "9+" : v.unreadCount}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-500">
                    <span
                      className={`rounded px-1.5 py-0.5 font-medium ${TIER_CLASS[v.tier]}`}
                    >
                      {TIER_LABEL[v.tier]}
                    </span>
                    <span className="truncate">{v.path ?? "—"}</span>
                    <span className="shrink-0">· {timeAgo(v.lastSeenAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex min-h-[26rem] flex-col rounded-xl border border-ink-700 bg-ink-900/60">
        {!selected ? (
          <p className="m-auto text-[13px] text-ink-500">
            Select a visitor to start chatting.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-white">
                  {selected.email ?? "Anonymous visitor"}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${TIER_CLASS[selected.tier]}`}
                  >
                    {TIER_LABEL[selected.tier]}
                  </span>
                  <span>{selected.path ?? "—"}</span>
                </div>
              </div>
            </div>

            <div
              ref={listRef}
              className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3"
            >
              {messages.length === 0 && (
                <p className="mt-2 text-center text-[12px] text-ink-500">
                  No messages yet.
                </p>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.sender === "visitor" ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[70%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                      m.sender === "visitor"
                        ? "bg-ink-800 text-ink-100"
                        : "bg-accent-500/20 text-white"
                    }`}
                  >
                    {m.body}
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <p className="px-4 pb-1 text-[11px] text-rose-400">{error}</p>
            )}

            <div className="flex items-end gap-2 border-t border-ink-800 p-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                rows={2}
                maxLength={2000}
                placeholder="Reply…"
                className="flex-1 resize-none rounded-lg border border-ink-650 bg-ink-850 px-3 py-2 text-[13px] text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
              />
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || !draft.trim()}
                className="rounded-lg bg-accent-500 px-3 py-2 text-[13px] font-medium text-ink-950 transition disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
