"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usd, type Spend } from "@/lib/format";
import { creditLabel } from "@/lib/pricing";

/**
 * Top chrome.
 *
 * The old header put the wordmark and four figures in one row with no
 * breakpoint, so on a phone they overlapped. Here the figures drop out of the
 * row below `md` and reappear as a stat strip underneath, where they have the
 * width to be legible instead of colliding.
 *
 * `spendSlot` and `accountExtra` are slots rather than imports so this file
 * has no opinion about whether credits or the cost popover exist yet.
 */
export default function StudioHeader({
  modelLabel,
  email,
  displayName,
  dailyQuota,
  usedToday,
  spend,
  balance,
  coverageCents,
  creditCents,
  isAdmin = false,
  spendSlot,
  accountExtra,
}: {
  modelLabel: string;
  email: string;
  displayName: string;
  dailyQuota: number;
  usedToday: number;
  spend: Spend;
  balance?: number | null;
  /**
   * The fal cost that outstanding customer credit represents. Admin only, and
   * null when it has not been measured.
   */
  coverageCents?: number | null;
  /** Omitted before the credits patch is applied; the figure simply hides. */
  creditCents?: number;
  /** Dollars, provider balance and the burst quota are operator-only. */
  isAdmin?: boolean;
  spendSlot?: ReactNode;
  accountExtra?: ReactNode;
}) {
  const remaining = Math.max(0, dailyQuota - usedToday);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {/* The one piece of chrome that always exists, so it doubles as the
              way back to the marketing site — the same "wordmark links home"
              convention as the header on `/`. A plain Link, not a button:
              this is navigation, not an action inside the studio. */}
          <Link
            href="/"
            className="whitespace-nowrap text-sm font-semibold tracking-tight text-white transition hover:text-accent-400"
          >
            Mic Studio
          </Link>
          <span className="hidden whitespace-nowrap rounded-md border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 sm:inline">
            {modelLabel}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden items-center gap-4 md:flex">
            {creditCents != null && (
              <span
                className="whitespace-nowrap text-xs text-ink-400"
                title="Your generation credit. Spent per clip, refunded automatically when a generation fails."
              >
                <span
                  className={`tabular-nums ${
                    creditCents <= 0
                      ? "font-medium text-amber-400"
                      : "text-ink-200"
                  }`}
                >
                  {isAdmin ? usd(creditCents) : creditLabel(creditCents)}
                </span>{" "}
                {/* The admin view shows this in dollars, so calling it
                    "credits" beside a dollar figure reads as a contradiction. */}
                {isAdmin ? "balance" : "credits"}
              </span>
            )}

            {isAdmin && balance != null && (
              <span
                className="whitespace-nowrap text-xs text-ink-400"
                title={
                  coverageCents != null
                    ? `fal balance. Customers hold credit worth ${usd(coverageCents)} of fal usage.`
                    : "Provider balance — visible to admins only."
                }
              >
                <span
                  className={
                    balance < 5 ? "font-medium text-amber-400" : "text-ink-200"
                  }
                >
                  ${balance.toFixed(2)}
                </span>{" "}
                left
                {/* The balance alone does not say whether it is enough. This
                    is the figure that does: what customers could still spend
                    if they all used what they hold. */}
                {coverageCents != null && coverageCents > 0 && (
                  <>
                    {" · "}
                    {Math.round(balance * 100) < coverageCents ? (
                      <span className="font-medium text-rose-400">
                        short {usd(coverageCents - Math.round(balance * 100))}
                      </span>
                    ) : (
                      <span className="text-ink-300">
                        covers {usd(coverageCents)}
                      </span>
                    )}
                  </>
                )}
              </span>
            )}

            {isAdmin && (spendSlot ?? (
              <span
                className="whitespace-nowrap text-xs text-ink-400"
                title={`Spend on successful generations. Failed jobs are not billed. All time: ${usd(spend.totalCents)}`}
              >
                <span className="tabular-nums text-ink-200">
                  {usd(spend.todayCents)}
                </span>{" "}
                spent today
              </span>
            ))}

            {isAdmin && (
              <span className="whitespace-nowrap text-xs text-ink-400">
                <span className="tabular-nums text-ink-200">{remaining}</span> of{" "}
                {dailyQuota} left today
              </span>
            )}
          </div>

          <details className="relative">
            <summary className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full bg-accent-500/20 text-xs font-semibold text-accent-400">
              {displayName.slice(0, 1).toUpperCase()}
            </summary>
            <div className="absolute right-0 top-10 z-20 w-64 rounded-xl border border-ink-700 bg-ink-900 p-3 shadow-xl">
              <p className="truncate text-xs text-ink-300">{email}</p>
              {accountExtra && <div className="mt-3">{accountExtra}</div>}
              <form action="/auth/signout" method="post" className="mt-3">
                <button className="w-full rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition hover:bg-ink-800">
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>
      </header>

      {/* Same figures, given room, on the widths where the row cannot hold them. */}
      <div className="flex shrink-0 gap-2 border-b border-ink-800 px-4 py-3 md:hidden">
        {creditCents != null && (
          <div className="flex flex-1 flex-col gap-0.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
            <span className="text-[10px] text-ink-400">Credits</span>
            <span
              className={`text-[13px] font-medium tabular-nums ${
                creditCents <= 0 ? "text-amber-400" : "text-white"
              }`}
            >
              {isAdmin ? usd(creditCents) : creditLabel(creditCents)}
            </span>
          </div>
        )}
        {isAdmin && (
          <>
            <div className="flex flex-1 flex-col gap-0.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
              <span className="text-[10px] text-ink-400">Spent today</span>
              <span className="text-[13px] font-medium tabular-nums text-white">
                {usd(spend.todayCents)}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-0.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
              <span className="text-[10px] text-ink-400">Left today</span>
              <span className="text-[13px] font-medium tabular-nums text-white">
                {remaining} of {dailyQuota}
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
