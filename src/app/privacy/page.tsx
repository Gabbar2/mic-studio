import type { Metadata } from "next";
import Link from "next/link";
// Shared, not a second copy. Two pages publishing different contact addresses
// is exactly the sort of thing a domain review notices.
import { CONTACT_EMAIL as CONTACT } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy — Mic Studio",
  description:
    "What Mic Studio collects, who processes it, and how to have it deleted.",
};

const UPDATED = "8 October 2026";


/**
 * The privacy policy.
 *
 * Two obligations meet here. The general one: the app takes email addresses
 * and card payments from the public, and every processor it hands data to has
 * to be named. The specific one: Cloudflare requires any site using Turnstile
 * to reference its Privacy Addendum, which is the paragraph under "Abuse
 * prevention" and the reason this page exists now rather than later.
 *
 * It is written as prose rather than clause-numbered legalese on purpose —
 * a policy nobody reads protects nobody.
 */
export default function PrivacyPage() {
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
          Privacy
        </h1>
        <p className="mt-2 text-xs text-ink-400">Last updated {UPDATED}</p>

        <p className="mt-8 text-sm leading-relaxed text-ink-300">
          Mic Studio turns a written prompt into a video clip. This page says
          what it keeps while doing that, who else sees it, and how to make it
          go away. It covers{" "}
          <span className="text-ink-200">micstudio.app</span> and{" "}
          <span className="text-ink-200">www.micstudio.app</span>.
        </p>

        <Section title="What is collected">
          <P>
            <B>Your email address</B>, if you give one. You can generate a clip
            without it. It becomes your account name and the address a sign-in
            link is sent to, and it is used for nothing else — no newsletter, no
            marketing list, no sale or transfer to anyone.
          </P>
          <P>
            <B>What you generate.</B> The prompt text, the settings you chose,
            any image or video you upload as a reference, and the finished clip.
            These are stored so the gallery can show them back to you.
          </P>
          <P>
            <B>Your credit history.</B> An append-only record of credits bought
            and spent, kept because a balance that cannot be audited is a
            balance you cannot trust.
          </P>
          <P>
            <B>Upload consent records.</B> Every file you upload is stored with
            a note of the confirmation you gave, the wording you were shown, the
            date, your IP address and your browser&apos;s user-agent string.
            This exists so that a complaint about someone&apos;s likeness can be
            answered with evidence rather than a guess. It is used for that and
            nothing else &mdash; never for analytics, profiling or advertising.
          </P>
          <P>
            <B>Live chat messages.</B> The chat bubble is provided by tawk.to,
            a third party, rather than stored on our own servers. Messages
            you send there are handled under tawk.to&apos;s own privacy
            policy, not this one &mdash; no account on this app is created by
            using it.
          </P>
          <P>
            <B>A session cookie.</B> One cookie, set to keep you signed in.
            There is no analytics script, no advertising pixel and no
            third-party tracker on this site.
          </P>
        </Section>

        <Section title="Who processes it">
          <P>
            Running the app means handing parts of this to other companies.
            Each is bound by its own terms not to use your data for its own
            purposes. Where a provider is described by category rather than by
            name, <B>you have the right to be told exactly who it is</B>. Ask
            and we will name them &mdash; write to{" "}
            <A href={`mailto:${CONTACT}`}>{CONTACT}</A>.
          </P>
          <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-ink-300">
            <Party name="AI model providers (United States)">
              Run the models that generate the video &mdash; currently Kling
              and Wan. Whichever one you pick for a given clip receives your
              prompt, your settings and any reference media you upload for
              that job, and does not keep it to train on.
            </Party>
            <Party name="A database and authentication provider (United States)">
              Database, file storage and sign-in. Holds your email, your clips
              and your credit ledger.
            </Party>
            <Party name="A web hosting provider (United States)">
              Hosts the site and keeps standard server logs.
            </Party>
            <Party name="A payment provider (United States)">
              Takes the payment when you buy credits. Your card details go to
              them directly and never reach this app — it is told only that a
              payment succeeded.
            </Party>
            <Party name="An email delivery provider (United States)">
              Sends sign-in links and receipts.
            </Party>
            <Party name="A DNS and bot-protection provider (United States)">
              DNS for the domain, and the abuse check described below &mdash;
              which names them, because that check carries a disclosure
              obligation of its own.
            </Party>
          </ul>
        </Section>

        <Section title="Where your data goes">
          <P>
            Every provider above is based in the <B>United States</B>, so using
            this service means your data is transferred outside the UAE and
            outside the European Economic Area.
          </P>
          <P>
            Those transfers rely on the providers&apos; own approved safeguards
            &mdash; in practice the European Commission&apos;s Standard
            Contractual Clauses, and the EU&ndash;US Data Privacy Framework
            where a provider is certified under it. Ask and we will tell you
            which mechanism a particular provider uses.
          </P>
        </Section>

        <Section title="Abuse prevention">
          <P>
            Sign-in and the free trial are protected by{" "}
            <B>Cloudflare Turnstile</B>, which checks that a request comes from
            a person rather than a script. It is used instead of a
            reCAPTCHA-style puzzle specifically because it does not profile you
            across the web or track you between sites, and it almost never asks
            you to do anything.
          </P>
          <P>
            Turnstile collects the information described in{" "}
            <A href="https://www.cloudflare.com/application-services/terms/turnstile-privacy-addendum/">
              Cloudflare&apos;s Turnstile Privacy Addendum
            </A>
            , and processes it under{" "}
            <A href="https://www.cloudflare.com/privacypolicy/">
              Cloudflare&apos;s Privacy Policy
            </A>
            . Mic Studio receives only a pass or fail from it.
          </P>
        </Section>

        <Section title="How long it is kept">
          <P>
            <B>Clips are kept for six months</B> from the day they were
            generated, then deleted along with the prompt and any file you
            uploaded for them. You can delete one sooner at any time.
          </P>
          <P>
            <B>Chat messages</B> are retained by tawk.to under their own
            retention policy, not ours, since the thread lives on their
            servers rather than in this app&apos;s database.
          </P>
          <P>
            Your account and email address stay until you ask us to remove
            them. Trial accounts that never produced a clip are cleared out
            periodically. Payment records are kept as long as tax and accounting
            rules require, which is out of anyone&apos;s hands here.
          </P>
          <P>
            Note that the video files themselves are served from the
            provider&apos;s storage and those links expire. Download anything
            you want to keep.
          </P>
          <P>
            <B>Early-cleanup notices.</B> Separately from the six-month
            schedule above, we may at our discretion select a specific group
            of accounts for an earlier cleanup &mdash; for example to reclaim
            storage from accounts that are no longer active. If yours is
            selected, we email the address on file with a deadline and links
            to the clips on that account, and that account&apos;s stored
            clips are deleted after the stated deadline. This never happens
            without that email being sent first, and never shortens the
            six-month window for any account that isn&apos;t specifically
            selected this way.
          </P>
        </Section>

        <Section title="Your choices">
          <P>
            Email <A href={`mailto:${CONTACT}`}>{CONTACT}</A> to get a copy of
            everything held about you, to correct it, or to have your account
            and clips deleted. Deletion is permanent and cannot be walked back —
            clips are not recoverable afterwards.
          </P>
          <P>
            Depending on where you live you may have further rights over this
            data, including under the GDPR. Ask, and they will be honoured
            without needing to be argued for.
          </P>
        </Section>

        <Section title="Children">
          <P>
            Mic Studio is not intended for anyone under 16 and accounts are not
            knowingly created for them. If one exists, write to the address
            above and it will be removed.
          </P>
        </Section>

        <Section title="Changes">
          <P>
            If this policy changes in a way that affects what is collected or
            who receives it, the date at the top changes and anyone with an
            account is emailed. Quiet rewrites are not a thing that happens
            here.
          </P>
        </Section>

        <p className="mt-12 border-t border-ink-800 pt-6 text-sm leading-relaxed text-ink-400">
          Questions about any of this go to{" "}
          <A href={`mailto:${CONTACT}`}>{CONTACT}</A>. The rules for using the
          service are in the{" "}
          <Link
            href="/terms"
            className="text-accent-400 underline underline-offset-2 transition hover:text-white"
          >
            terms of use
          </Link>
          .
        </p>
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-accent-400">
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm leading-relaxed text-ink-300">{children}</p>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return <span className="font-medium text-white">{children}</span>;
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
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

/**
 * A named processor, or a category.
 *
 * `href` is optional: a provider described by category has no page to link to,
 * and linking one would defeat the point of describing it that way.
 */
function Party({
  name,
  href,
  children,
}: {
  name: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="border-l border-ink-800 pl-3">
      {href ? (
        <A href={href}>{name}</A>
      ) : (
        <span className="font-medium text-ink-200">{name}</span>
      )}{" "}
      — {children}
    </li>
  );
}
