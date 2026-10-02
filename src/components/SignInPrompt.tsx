"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { LOCK_COPY, UNLOCKS, type TrialLock } from "@/lib/trialLocks";
import GoogleIcon from "@/components/GoogleIcon";

/**
 * The ask.
 *
 * One modal serves every trial limit, because the answer to all of them is the
 * same — an email address — and a person who has hit two of them should not be
 * learning a new interface for the second.
 *
 * The branch that matters is which Supabase call to make:
 *
 * - **Mid-trial** (an anonymous account exists, because they have generated
 *   something) it is `updateUser`, which converts that account in place. The
 *   user id does not change, so the clip they just made is already theirs and
 *   there is no migration to get wrong.
 * - **Before any clip** there is no account yet, so it is `signInWithOtp`,
 *   which creates one.
 *
 * Getting this backwards is how people lose work: `signInWithOtp` on an
 * existing anonymous session signs them into a *different* account and strands
 * the clip they were trying to keep.
 */
export default function SignInPrompt({
  lock,
  signedIn,
  getCaptchaToken,
  onClose,
}: {
  lock: TrialLock;
  /** True when an anonymous account already exists. Decides the call below. */
  signedIn: boolean;
  getCaptchaToken?: () => Promise<string | undefined>;
  onClose: () => void;
}) {
  const copy = LOCK_COPY[lock];
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // Same reasoning as the top-level login page: a Google click navigates the
  // page away immediately, so this only ever shows briefly before the
  // redirect, or turns into an error if Supabase refuses the attempt.
  const [googleLoading, setGoogleLoading] = useState(false);

  // Escape closes. A modal that traps someone who only wanted to look at the
  // Pro button is a modal they resent opening.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || state === "sending") return;

    setState("sending");
    setError(null);

    const supabase = createClient();
    const address = email.trim();

    const { error: authError } = signedIn
      ? await supabase.auth.updateUser({ email: address })
      : await supabase.auth.signInWithOtp({
          email: address,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=/studio`,
            captchaToken: await getCaptchaToken?.(),
          },
        });

    if (authError) {
      setError(
        /already/i.test(authError.message)
          ? "That email already has an account. Sign in on it instead."
          : authError.message,
      );
      setState("error");
      return;
    }

    setState("sent");
  }

  async function signInWithGoogle() {
    setGoogleLoading(true);
    setError(null);

    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=/studio`;

    // Same branch as the email path above, and for the same reason: a
    // signed-in visitor here already has an anonymous account holding their
    // trial clip. `linkIdentity` attaches Google to that existing account in
    // place — same user id, clip stays put. `signInWithOAuth` is for a
    // visitor who has not generated anything yet and has no account at all.
    // (Linking requires "Allow manual linking" on in Supabase's Auth
    // settings — see the note left in .env.example.)
    const { error: authError } = signedIn
      ? await supabase.auth.linkIdentity({
          provider: "google",
          options: { redirectTo },
        })
      : await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo },
        });

    // On success the browser is already navigating to Google.
    if (authError) {
      setError(authError.message);
      setGoogleLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="relative w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Same gradient rim as the login card and the gallery tiles, so this
            reads as part of the app rather than a browser dialog. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[17px]"
          style={{
            background:
              "linear-gradient(150deg, rgba(198,248,44,0.55) 0%, rgba(198,248,44,0.09) 34%, rgba(34,39,29,0.95) 68%)",
          }}
        />

        <div className="relative rounded-2xl bg-gradient-to-b from-ink-850 via-ink-900 to-ink-950 p-6 shadow-2xl shadow-black/60">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-lg px-2 py-1 text-lg leading-none text-ink-400 transition hover:text-white"
          >
            ×
          </button>

          {state === "sent" ? (
            <>
              <h2 className="pr-6 text-base font-semibold text-white">
                Check your inbox
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">
                We sent a link to{" "}
                <span className="font-medium text-white">{email}</span>. Click
                it and everything above unlocks.
              </p>
              {signedIn && (
                <p className="mt-3 rounded-lg border border-accent-500/25 bg-accent-500/10 p-3 text-xs leading-relaxed text-ink-200">
                  Your clip is already saved to this account — the link just
                  puts your name on it.
                </p>
              )}
              <button
                onClick={onClose}
                className="mt-5 w-full rounded-xl border border-ink-650 px-4 py-2.5 text-sm text-ink-200 transition hover:border-ink-600 hover:text-white"
              >
                Close
              </button>
            </>
          ) : (
            <>
              <h2 className="pr-6 text-base font-semibold leading-snug text-white">
                {copy.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-300">
                {copy.body}
              </p>

              <ul className="mt-4 space-y-1.5">
                {UNLOCKS.map((u) => (
                  <li
                    key={u}
                    className="flex items-center gap-2 text-xs text-ink-300"
                  >
                    <span
                      aria-hidden
                      className="h-1 w-1 shrink-0 rounded-full bg-accent-400"
                    />
                    {u}
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={signInWithGoogle}
                disabled={googleLoading}
                className="mt-5 flex w-full items-center justify-center gap-2.5 rounded-xl border border-ink-650 bg-white px-3.5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-ink-100 disabled:opacity-50"
              >
                <GoogleIcon className="h-4 w-4 shrink-0" />
                {googleLoading ? "Redirecting…" : "Continue with Google"}
              </button>

              <div className="mt-4 flex items-center gap-3">
                <div className="h-px flex-1 bg-ink-800" />
                <span className="text-[11px] uppercase tracking-wide text-ink-400">
                  or
                </span>
                <div className="h-px flex-1 bg-ink-800" />
              </div>

              <form onSubmit={submit} className="mt-4 space-y-2">
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-ink-650 bg-ink-950/70 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-ink-400 focus:border-accent-500"
                />
                <button
                  type="submit"
                  disabled={state === "sending"}
                  className="w-full rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
                >
                  {state === "sending" ? "Sending…" : copy.cta}
                </button>
              </form>

              {error && (
                <p className="mt-3 text-xs leading-relaxed text-red-400">
                  {error}
                </p>
              )}

              <p className="mt-3 text-center text-[11px] text-ink-400">
                No password, no card. We email you a link.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
