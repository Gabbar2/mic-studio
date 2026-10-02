"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { useTurnstile } from "@/components/useTurnstile";
import GoogleIcon from "@/components/GoogleIcon";

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/studio";
  const { getToken, Widget } = useTurnstile();

  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // Separate from `state` above: a Google click navigates the whole page away
  // to Google's consent screen, so there is no "sent" state to show for it —
  // only a brief moment where the button should look busy before the redirect
  // fires, and an error slot for when Supabase rejects the attempt outright.
  const [googleLoading, setGoogleLoading] = useState(false);

  async function signInWithGoogle() {
    setGoogleLoading(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    // On success the browser is already navigating to Google, so there is
    // nothing left to render here. Only surface a failure.
    if (error) {
      setError(error.message);
      setGoogleLoading(false);
    }
  }

  async function signInWithEmail(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError(null);

    // Awaited here rather than gating the button: the challenge normally
    // resolves long before anyone finishes typing an address, and on the rare
    // occasion it has not, a second of wait beats a button that looked broken.
    const captchaToken = await getToken();

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        captchaToken,
      },
    });

    if (error) {
      setError(error.message);
      setState("error");
    } else {
      setState("sent");
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        Mic Studio Login
      </h1>
      <p className="mt-2 text-sm text-ink-400">
        No password. We&apos;ll email you a link.
      </p>

      {state === "sent" ? (
        <div className="mt-8 rounded-xl border border-accent-500/30 bg-accent-500/10 p-4 text-sm text-ink-200">
          Check <span className="font-medium text-white">{email}</span> for your
          sign-in link.
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={signInWithGoogle}
            disabled={googleLoading}
            className="mt-8 flex w-full items-center justify-center gap-2.5 rounded-xl border border-ink-650 bg-white px-4 py-3 text-sm font-semibold text-ink-950 transition hover:bg-ink-100 disabled:opacity-50"
          >
            <GoogleIcon className="h-4 w-4 shrink-0" />
            {googleLoading ? "Redirecting…" : "Continue with Google"}
          </button>

          <div className="mt-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-ink-800" />
            <span className="text-[11px] uppercase tracking-wide text-ink-400">
              or
            </span>
            <div className="h-px flex-1 bg-ink-800" />
          </div>

          <form onSubmit={signInWithEmail} className="mt-5 space-y-3">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@studio.com"
            /* Darker than the card it sits in — on a gradient fill an
               ink-900 field lands the same value as its surroundings and
               stops looking like an input. */
            className="w-full rounded-xl border border-ink-700 bg-ink-950/70 px-4 py-3 text-sm text-white outline-none placeholder:text-ink-400 focus:border-accent-500"
          />
          <button
            type="submit"
            disabled={state === "sending"}
            className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-accent-ink transition hover:bg-accent-400 disabled:opacity-50"
          >
            {state === "sending" ? "Sending…" : "Email me a link"}
          </button>

          <Widget />
          </form>
        </>
      )}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {/* A way out of the wall. Anyone landing here from a bookmark or the
          header button is one click from the trial instead of stuck at a
          sign-in form they have no account for. */}
      {state !== "sent" && (
        <p className="mt-5 border-t border-ink-800 pt-5 text-xs text-ink-400">
          No account?{" "}
          <Link href="/studio" className="text-accent-400 hover:text-white">
            Try it free, no sign-up →
          </Link>
        </p>
      )}

      <p className="mt-6 text-[11px] leading-relaxed text-ink-400">
        Protected by Cloudflare Turnstile.{" "}
        <Link href="/privacy" className="underline hover:text-ink-300">
          Privacy
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      {/* Room light. accent-600 rather than accent-500 and low alpha, same
          reasoning as the landing hero: lime at full strength stops being a
          glow and becomes a haze across the type. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-16rem] h-[34rem] w-[52rem] -translate-x-1/2 rounded-full opacity-45 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(164,212,24,0.3) 0%, rgba(164,212,24,0) 70%)",
        }}
      />

      {/* The card. Gradient rim on the outside, gradient fill inside — the
          fill runs top-down so the heading sits on the lighter end and the
          button on the darker, which keeps the lime button the brightest
          thing on the screen. */}
      <div className="relative w-full max-w-sm">
        <div
          aria-hidden
          className="pointer-events-none absolute -inset-px rounded-[17px]"
          style={{
            background:
              "linear-gradient(150deg, rgba(198,248,44,0.55) 0%, rgba(198,248,44,0.09) 34%, rgba(34,39,29,0.95) 68%)",
          }}
        />
        <div className="relative rounded-2xl bg-gradient-to-b from-ink-850 via-ink-900 to-ink-950 p-7 shadow-2xl shadow-black/50">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
