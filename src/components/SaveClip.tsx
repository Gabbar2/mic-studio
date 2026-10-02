"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";

/**
 * The moment identity is asked for.
 *
 * A trial visitor has already watched their clip render. Only now, when they
 * want to keep it, are they asked for an email — which is the whole reason the
 * sign-in wall moved: the ask lands after the value, not in front of it.
 *
 * Supabase converts the anonymous user in place and the id does not change, so
 * the clip they just made stays theirs. Nothing is migrated, nothing is lost,
 * and there is no "your work will be transferred" promise to keep.
 */
export default function SaveClip({ onDone }: { onDone?: () => void }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === "sending") return;

    setState("sending");
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({
      email: email.trim(),
    });

    if (updateError) {
      // The common one is an address that already has an account. Say that,
      // rather than the raw message, because the fix is different.
      setError(
        /already/i.test(updateError.message)
          ? "That email already has an account. Sign in on it instead."
          : updateError.message,
      );
      setState("error");
      return;
    }

    setState("sent");
    onDone?.();
  }

  if (state === "sent") {
    return (
      <div className="rounded-lg border border-accent-500/30 bg-accent-500/10 p-3 text-[11px] leading-relaxed text-ink-200">
        Check <span className="font-medium text-white">{email}</span> and click
        the link. Your clip is waiting.
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-2">
      <p className="text-[11px] leading-relaxed text-ink-400">
        Add your email to keep this clip and carry on generating.
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="min-w-0 flex-1 rounded-lg border border-ink-650 bg-ink-950/70 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-400 focus:border-accent-500"
        />
        <button
          type="submit"
          disabled={state === "sending"}
          className="shrink-0 rounded-lg bg-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
        >
          {state === "sending" ? "Sending…" : "Save it"}
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-400">{error}</p>}
    </form>
  );
}
