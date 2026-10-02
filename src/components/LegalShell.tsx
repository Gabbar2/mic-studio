import Link from "next/link";
import {
  LEGAL_NAME_PLACEHOLDER,
  LEGAL_UPDATED,
  legalNameIsSet,
} from "@/lib/legal";

/**
 * The frame every legal page sits in.
 *
 * Three pages needed the same header, the same lime wash and the same
 * typography, and were about to grow three slightly different versions of
 * each. The banner is the reason this is a component rather than a copied
 * layout: an unfilled legal name has to be impossible to miss on every page at
 * once, not on whichever one someone remembered to check.
 */
export default function LegalShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-ink-950">
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-20rem] h-[34rem] w-[52rem] -translate-x-1/2 rounded-full opacity-35 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, rgba(164,212,24,0.28) 0%, rgba(164,212,24,0) 70%)",
        }}
      />

      <div className="relative z-10 mx-auto max-w-2xl px-6 py-16 sm:py-24">
        <Link
          href="/"
          className="text-xs text-ink-400 transition hover:text-accent-400"
        >
          ← Mic Studio
        </Link>

        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-white">
          {title}
        </h1>
        <p className="mt-2 text-xs text-ink-400">
          Last updated {LEGAL_UPDATED}
        </p>

        {!legalNameIsSet() && (
          <div className="mt-6 rounded-xl border border-rose-500/40 bg-rose-500/[0.08] p-4">
            <p className="text-[13px] leading-relaxed text-rose-200/90">
              <span className="font-medium text-rose-100">
                Not ready to publish.
              </span>{" "}
              <code className="text-rose-200">{LEGAL_NAME_PLACEHOLDER}</code> is
              still a placeholder in{" "}
              <code className="text-rose-200">src/lib/legal.ts</code>. Paddle
              asks sole proprietors to name themselves in the Terms, and a
              domain review will fail on this alone.
            </p>
          </div>
        )}

        {children}

        <nav className="mt-14 flex flex-wrap gap-x-5 gap-y-2 border-t border-ink-800 pt-6 text-xs text-ink-400">
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
        </nav>
      </div>
    </main>
  );
}

export function Section({
  n,
  title,
  flag,
  children,
}: {
  n?: string;
  title: string;
  flag?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2
        className={`text-sm font-semibold uppercase tracking-wide ${
          flag ? "text-rose-400" : "text-accent-400"
        }`}
      >
        {n ? `${n}. ` : ""}
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function P({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-sm leading-relaxed text-ink-300 ${className}`}>
      {children}
    </p>
  );
}

export function B({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-white">{children}</span>;
}

export function A({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target={href.startsWith("mailto:") ? undefined : "_blank"}
      rel="noopener noreferrer"
      className="text-accent-400 underline underline-offset-2 transition hover:text-white"
    >
      {children}
    </a>
  );
}
