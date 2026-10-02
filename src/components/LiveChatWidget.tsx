"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { useTurnstile } from "./useTurnstile";
import {
  CHAT_POLL_MS,
  PRESENCE_PING_MS,
  UNREAD_POLL_MS,
  type ChatMessageRow,
} from "@/lib/presence";

/**
 * The visitor-facing half of live chat: a floating bubble, a thread, and a
 * quiet presence heartbeat while a session exists.
 *
 * Mounted once in the root layout so it follows a visitor across every page
 * — but it never creates a session itself. Presence pings and the closed
 * widget's unread poll both check for an *existing* session first and stay
 * silent without one; only pressing Send mints an anonymous account (via
 * the same Turnstile-gated signInAnonymously Studio.tsx uses before a
 * Generate or an upload). That is deliberate: this app already avoids
 * creating an anonymous account on page load specifically so a crawler
 * doesn't turn into a row in auth.users, and a presence beacon that fired
 * for everyone regardless of session would quietly undo that. The practical
 * effect is that a pure lurker who never generates and never opens chat
 * doesn't show up in the admin's live list — only visitors who have taken
 * some unambiguous action have.
 */
export default function LiveChatWidget() {
  const pathname = usePathname();
  const isAdminRoute = pathname?.startsWith("/admin") ?? false;

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getToken, Widget } = useTurnstile();
  const anonInFlight = useRef<Promise<boolean> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Tracks the most recent message id we've already accounted for, so a poll
  // can tell "a reply just arrived" apart from "this is the same thread we
  // already knew about". hasBaselineRef gates that comparison until the
  // first fetch has actually run — without it, a visitor returning with old
  // unread messages from a prior visit would have the panel yanked open the
  // moment this component mounts, which is worse than the badge it replaces.
  const latestMessageIdRef = useRef<string | null>(null);
  const hasBaselineRef = useRef(false);

  const hasSession = useCallback(async () => {
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return !!session;
  }, []);

  /** Same pattern as Studio.tsx's ensureSession — see the file doc comment. */
  const ensureSession = useCallback(async (): Promise<boolean> => {
    if (anonInFlight.current) return anonInFlight.current;

    const run = (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) return true;

      const captchaToken = await getToken();
      const { error: anonError } = await supabase.auth.signInAnonymously({
        options: { captchaToken },
      });
      return !anonError;
    })();

    anonInFlight.current = run;
    try {
      return await run;
    } finally {
      anonInFlight.current = null;
    }
  }, [getToken]);

  const fetchMessages = useCallback(
    async (markRead: boolean) => {
      if (!(await hasSession())) return;
      try {
        const res = await fetch(
          `/api/chat/messages${markRead ? "?markRead=true" : ""}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const list: ChatMessageRow[] = data.messages ?? [];
        setMessages(list);
        setUnreadCount(data.unreadCount ?? 0);

        const latest = list.length > 0 ? list[list.length - 1] : null;
        if (hasBaselineRef.current) {
          // A fresh admin message since the last time we checked — pop the
          // panel open so a reply feels immediate rather than something the
          // visitor has to notice a badge for and click themselves. Only
          // fires for a reply that arrives while they're already here; see
          // the ref's doc comment for why the very first fetch never does
          // this on its own.
          const isNewAdminReply =
            !!latest &&
            latest.sender === "admin" &&
            latest.id !== latestMessageIdRef.current;
          if (isNewAdminReply) setOpen(true);
        } else {
          hasBaselineRef.current = true;
        }
        latestMessageIdRef.current = latest?.id ?? latestMessageIdRef.current;
      } catch {
        // Transient — the next poll retries.
      }
    },
    [hasSession],
  );

  const ping = useCallback(async () => {
    if (!(await hasSession())) return;
    try {
      await fetch("/api/presence/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathname ?? "/" }),
      });
    } catch {
      // Transient — the next heartbeat retries.
    }
  }, [hasSession, pathname]);

  // Presence heartbeat. Fires immediately on mount and on every path change
  // (so a navigation updates "where they are" right away), then on a fixed
  // interval. Skips entirely on /admin and while the tab is hidden — an
  // idle background tab, or an admin browsing their own site, has no reason
  // to keep pinging.
  useEffect(() => {
    if (isAdminRoute) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void ping();
    };
    tick();
    const id = setInterval(tick, PRESENCE_PING_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdminRoute, ping]);

  // Message polling: fast and read-marking while the panel is open, slow and
  // read-preserving while closed (just enough to keep the unread badge
  // honest without quietly clearing it before the visitor has looked).
  useEffect(() => {
    if (isAdminRoute) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || document.hidden) return;
      void fetchMessages(open);
    };
    tick();
    const id = setInterval(tick, open ? CHAT_POLL_MS : UNREAD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isAdminRoute, open, fetchMessages]);

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, open]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    try {
      const ok = await ensureSession();
      if (!ok) {
        setError("Couldn't verify that — give it a moment and try again.");
        return;
      }

      const res = await fetch("/api/chat/messages", {
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
      await fetchMessages(true);
      // Starts the presence heartbeat right away rather than waiting for the
      // next tick, now that sending just created a session for a visitor who
      // didn't have one yet.
      void ping();
    } finally {
      setSending(false);
    }
  }

  if (isAdminRoute) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="flex h-[26rem] w-80 flex-col overflow-hidden rounded-xl border border-ink-650 bg-ink-900 shadow-2xl">
          <div className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-4 py-3">
            <span className="text-sm font-semibold text-white">
              Chat with us
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close chat"
              className="text-ink-400 transition hover:text-white"
            >
              ✕
            </button>
          </div>

          <div
            ref={listRef}
            className="flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
          >
            {messages.length === 0 && (
              <p className="mt-2 text-center text-[12px] leading-relaxed text-ink-400">
                Ask us anything — we usually reply within a few minutes.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${m.sender === "admin" ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                    m.sender === "admin"
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
            <p className="px-3 pb-1 text-[11px] text-rose-400">{error}</p>
          )}

          <div className="flex items-end gap-2 border-t border-ink-700 bg-ink-850 p-2.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder="Type a message…"
              className="flex-1 resize-none rounded-lg border border-ink-650 bg-ink-900 px-2.5 py-2 text-[13px] text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
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
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void fetchMessages(true);
        }}
        aria-label={open ? "Close chat" : "Open chat"}
        className="relative flex h-12 w-12 items-center justify-center rounded-full bg-accent-500 text-ink-950 shadow-lg transition hover:bg-accent-400"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
          />
        </svg>
        {!open && unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      <Widget />
    </div>
  );
}
