import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { MODELS } from "@/lib/models";

/**
 * The three generation modes, then audio — which is a modifier on any of them
 * rather than a fourth way in.
 *
 * Reference carries a Beta tag because it genuinely is one. It runs on a
 * different Kling endpoint from the other two and the output is weaker than
 * what the newer reference models produce, so the tag is doing real work here:
 * it sets the expectation before someone spends credits, rather than after.
 * The body copy names the one thing that actually moves the result — how clean
 * the source clip is — so the tag reads as guidance and not as an apology.
 */
const FEATURES: { title: string; body: string; tag?: string }[] = [
  { title: "Text to video", body: "Describe a shot in plain language." },
  { title: "Image to video", body: "Bring a still frame into motion." },
  {
    title: "Reference to video",
    body: "Carry the motion of a clip you upload. Best with clean, single-subject footage.",
    tag: "Beta",
  },
  {
    title: "Native audio",
    body: "Dialogue and ambience generated with the picture.",
  },
];

/** "A, B & C" — plain commas, "&" only before the last one. */
function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} & ${labels[labels.length - 1]}`;
}

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Whole-page ambient wash, not a hero-only blob — see .ambient-glow in
          globals.css. `fixed` so it stays put behind every section (hero,
          feature cards, footer) as the page scrolls, instead of scrolling
          away with the hero. */}
      <div aria-hidden className="ambient-glow" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="text-sm font-semibold tracking-tight text-white">
          Mic Studio
        </span>
        <Link
          href={user ? "/studio" : "/login"}
          className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
        >
          {user ? "Open studio" : "Sign in"}
        </Link>
      </header>

      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-24 pt-20 text-center">
        <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900/70 px-3 py-1 text-xs text-ink-300">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
          {/* Built from MODELS rather than naming models by hand, so this
              badge can't drift the next time one is added or retired. */}
          Powered by {joinLabels(MODELS.map((m) => m.label))}
        </p>

        <h1 className="text-balance text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl">
          Type a scene.
          <br />
          Get a film.
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-ink-300">
          Pick the model for the job — Kling for the sharpest result, Wan for
          a faster, cheaper clip — and describe the scene. Mic Studio handles
          the rest.
        </p>

        {/* Always /studio, signed in or not.

            This used to send a signed-out visitor to /login, which quietly
            defeated the entire anonymous trial: the one door a stranger
            actually walks through led to the sign-in wall the trial exists to
            remove. /studio is open to everyone now — the composer works, and
            the account is created on Generate. */}
        <Link
          href="/studio"
          className="mt-10 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-6 py-3 text-sm font-semibold text-accent-ink shadow-lg shadow-accent-500/25 transition hover:bg-accent-400"
        >
          {user ? "Start generating" : "Try it free"}
          <span aria-hidden>→</span>
        </Link>

        <p className="mt-4 text-xs text-ink-400">
          {user
            ? "Free while in beta · 5 generations a day"
            : "One free clip · No sign-up, no card"}
        </p>
      </section>

      {/* 2x2 rather than a row of four. At four across the columns are ~190px
          of content, and "Reference to video" plus its badge does not fit on
          one line at that width — the title wrapped and the badge drifted off
          on its own. Two across gives every title room and absorbs the fact
          that the reference card carries more copy than the rest. */}
      <section className="relative z-10 mx-auto grid max-w-3xl gap-4 px-6 pb-24 sm:grid-cols-2">
        {FEATURES.map(({ title, body, tag }) => (
          <div
            key={title}
            className="rounded-2xl border border-ink-800 bg-ink-900/60 p-5 text-left"
          >
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              {tag && (
                <span className="shrink-0 rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400">
                  {tag}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{body}</p>
          </div>
        ))}
      </section>

      {/* A policy nobody can find is not a policy. One line, at the foot of
          the only page a stranger definitely lands on. */}
      <footer className="relative z-10 border-t border-ink-800/70 px-6 py-8">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 text-xs text-ink-400">
          <span>© {new Date().getFullYear()} Mic Studio</span>
          {/* All four reachable from navigation. Paddle's domain review
              checks for exactly this, and a policy nobody can find is not a
              policy regardless of who is looking. */}
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <Link href="/pricing" className="transition hover:text-accent-400">
              Pricing
            </Link>
            <Link href="/terms" className="transition hover:text-accent-400">
              Terms
            </Link>
            <Link href="/refunds" className="transition hover:text-accent-400">
              Refunds
            </Link>
            <Link href="/privacy" className="transition hover:text-accent-400">
              Privacy
            </Link>
          </span>
        </div>
      </footer>
    </main>
  );
}
