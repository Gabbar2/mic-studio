import { usd } from "@/lib/format";

/**
 * The in-app twin of sendLowBalanceAlert (see lib/alerts.ts) — same numbers,
 * same "customers hold more than fal can currently cover" condition, just
 * surfaced the moment an admin opens this page instead of waiting on the
 * cron's once-per-drop email. The email already exists and still fires on
 * its own schedule; this is a second, independent place to see the same
 * thing, not a replacement for it — an admin who skips email entirely still
 * sees this the next time they check in here.
 *
 * Deliberately a plain server component, not a client-polled one: this page
 * is already `force-dynamic` and re-fetches on every load, which is exactly
 * the cadence an admin dashboard warning needs — no reason to add a client
 * round-trip on top of a number the page already has.
 *
 * Renders nothing when there's nothing to say, same reasoning as the rest of
 * this app's alerting: a banner that's always there gets ignored.
 */
export default function BalanceAlertBanner({
  balanceCents,
  coverageCents,
}: {
  /** Real fal.ai account balance, in cents. Null if it has never been measured. */
  balanceCents: number | null;
  /** What it would cost at fal if every customer spent every credit they hold. */
  coverageCents: number;
}) {
  if (balanceCents == null) return null;

  const shortCents = coverageCents - balanceCents;
  if (shortCents <= 0) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3"
    >
      <p className="text-sm font-medium text-amber-300">
        fal balance is low — short {usd(shortCents)} of what's been sold
      </p>
      <p className="mt-1 text-xs leading-relaxed text-amber-200/80">
        fal.ai balance is {usd(balanceCents)}. Customers currently hold
        credit worth {usd(coverageCents)} of fal usage — if everyone spent
        what they hold right now, fal would run out {usd(shortCents)} short.
        New generations are refused politely rather than failing part-way
        through, but it's worth topping up before that starts happening.{" "}
        <a
          href="https://fal.ai/dashboard/billing"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-white"
        >
          Top up fal.ai →
        </a>
      </p>
    </div>
  );
}
