import type { Metadata } from "next";
import Link from "next/link";
import LegalShell, { B, P, Section } from "@/components/LegalShell";
import SubscribeButton from "@/components/SubscribeButton";
import BuyPackButton from "@/components/BuyPackButton";
import { CREDIT_PACKS, SUBSCRIPTION_PLANS, priceMarkup } from "@/lib/credits";
import { creditLabel, roundChargeCents } from "@/lib/pricing";
import {
  effectiveMarkup,
  estimateCostCents,
  MODELS,
  QUALITY_LABEL,
  qualitiesFor,
  resolutionFor,
  type ModelDef,
  type Quality,
} from "@/lib/models";
import { REFUND_WINDOW_DAYS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Pricing — Mic Studio",
  description:
    "Pay as you go with credit packs, or subscribe monthly or yearly for a recurring bonus. Credits never expire, and you are only charged when a video succeeds.",
};

/**
 * Public pricing.
 *
 * Every number is computed here from the same functions the composer and the
 * server use. None of it is typed by hand, because a pricing page that drifts
 * from the checkout is worse than no pricing page — and this codebase has
 * already produced one rounding bug where the quote and the charge disagreed.
 *
 * Paddle's domain review requires a visible pricing page. This is that, but it
 * is also the page that answers "what does a video actually cost", which the
 * studio could only tell you after you had already opened it.
 */
export default function PricingPage() {
  const globalMarkup = priceMarkup();

  return (
    <LegalShell title="Pricing">
      <p className="mt-8 text-sm leading-relaxed text-ink-300">
        Buy credits once and spend them when you like, or subscribe for a
        recurring bonus. Either way, <B>credits never expire</B> and you are
        charged only when a video succeeds.
      </p>

      {/* ---------- packs ---------- */}
      <Section title="Credit packs">
        <div className="mt-1 grid gap-3 sm:grid-cols-3">
          {CREDIT_PACKS.map((pack) => {
            const bonus = pack.creditCents - pack.priceCents;
            return (
              <div
                key={pack.id}
                className="relative rounded-xl border border-ink-700 bg-ink-900/60 p-4"
              >
                <div className="text-2xl font-semibold tracking-tight text-white">
                  {pack.label}
                </div>
                <div className="mt-1 text-sm tabular-nums text-accent-400">
                  {creditLabel(pack.creditCents)} credits
                </div>
                {bonus > 0 && (
                  <div className="mt-2 inline-block rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400">
                    +${(bonus / 100).toFixed(2)} free
                  </div>
                )}
                <BuyPackButton
                  packId={pack.id}
                  label={`Buy · ${pack.label}`}
                />
              </div>
            );
          })}
        </div>
        <P className="mt-4">
          One-off purchases. Nothing to cancel, because nothing renews.
        </P>
      </Section>

      {/* ---------- subscriptions ---------- */}
      <Section title="Subscribe">
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          {SUBSCRIPTION_PLANS.map((plan) => {
            const bonus = plan.creditCents - plan.priceCents;
            return (
              <div
                key={plan.id}
                className="relative rounded-xl border border-ink-700 bg-ink-900/60 p-4"
              >
                <div className="text-2xl font-semibold tracking-tight text-white">
                  {plan.label}
                </div>
                <div className="mt-1 text-sm tabular-nums text-ink-300">
                  ${(plan.priceCents / 100).toFixed(0)}/{plan.interval}
                </div>
                <div className="mt-1 text-sm tabular-nums text-accent-400">
                  {creditLabel(plan.creditCents)} credits
                  {plan.interval === "month" ? " a month" : " up front"}
                </div>
                {bonus > 0 && (
                  <div className="mt-2 inline-block rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400">
                    +${(bonus / 100).toFixed(2)} free
                  </div>
                )}
                <SubscribeButton
                  planId={plan.id}
                  label={`Subscribe · $${(plan.priceCents / 100).toFixed(0)}/${plan.interval}`}
                />
              </div>
            );
          })}
        </div>
        <P className="mt-4">
          Credits from a subscription land in the same balance as a pack and
          never expire, so nothing is lost by canceling. Manage or cancel any
          time from the account menu in the studio &mdash; that opens our
          payment provider&rsquo;s own billing portal, where changes take
          effect immediately with no proration owed either way.
        </P>
      </Section>

      {/* ---------- what a clip costs ---------- */}
      <Section title="What a video costs">
        <P>
          Every price is in credits, and the exact figure is shown on the
          Generate button before you press it. Mic Studio runs more than one
          model &mdash; pick Kling for the sharpest result, or Wan for a much
          cheaper clip that still holds up well for shorter, social-style
          videos.
        </P>

        {MODELS.map((model) => (
          <div key={model.id} className="mt-6 first:mt-2">
            <h3 className="text-sm font-semibold text-white">
              {model.label}
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-400">
              {model.description}
            </p>
            <div className="mt-2">
              <ModelCostTable
                model={model}
                markup={effectiveMarkup(model, globalMarkup)}
              />
            </div>
          </div>
        ))}

        <P className="mt-4">
          Reference to video is billed at the quality tier shown above for
          every model, except on Kling specifically: attaching a reference{" "}
          <em>video</em> there routes to a different endpoint billed at a
          single flat rate instead. Wan&rsquo;s reference mode accepts
          reference images only. 4K upscaling of a finished clip is priced
          separately &mdash; both are shown in the studio before you commit.
        </P>
      </Section>

      {/* ---------- free ---------- */}
      <Section title="Trying it">
        <P>
          Your first video is free and needs no account at all &mdash; no email,
          no card. Add an email afterwards and you get a larger free balance,
          still without paying, which unlocks image-to-video, 10-second clips
          and generated audio. Pro, native 4K, 15-second clips and
          reference-to-video open up once you subscribe or buy credits.
        </P>
      </Section>

      <Section title="Refunds">
        <P>
          Unused credits are refundable for {REFUND_WINDOW_DAYS} days. Failed
          generations are refunded automatically and immediately. The full
          policy is on the{" "}
          <Link
            href="/refunds"
            className="text-accent-400 underline underline-offset-2 transition hover:text-white"
          >
            refunds page
          </Link>
          .
        </P>
      </Section>

      <Section title="Prices">
        <P>
          Prices are in US dollars and may change; a change never affects
          credits you already hold. Taxes are added at checkout where they
          apply, and your receipt comes from our payment provider, who acts as
          merchant of record for the sale.
        </P>
      </Section>
    </LegalShell>
  );
}

/**
 * One model's own price table: a row per quality tier it offers, a column
 * per duration it offers (plus a second set of audio columns when the model
 * actually supports audio — Wan doesn't, so its table is just the silent
 * columns, not silent columns next to empty "+ audio" ones).
 */
function ModelCostTable({
  model,
  markup,
}: {
  model: ModelDef;
  markup: number;
}) {
  const qualities = qualitiesFor(model, "text2video");
  const columns = [
    ...model.durations.map((secs) => ({
      label: `${secs}s`,
      secs,
      audio: false,
    })),
    ...(model.supportsAudio
      ? model.durations.map((secs) => ({
          label: `${secs}s + audio`,
          secs,
          audio: true,
        }))
      : []),
  ];

  const priceFor = (q: Quality, secs: number, audio: boolean) =>
    roundChargeCents(
      estimateCostCents(model, "text2video", q, secs, audio) * markup,
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border-b border-ink-700 py-2 pr-3 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
              Quality
            </th>
            {columns.map((c, i) => (
              <th
                key={c.label}
                className={`border-b border-ink-700 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400 ${
                  i === columns.length - 1 ? "pl-3" : "px-3"
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {qualities.map((q) => (
            <tr key={q}>
              <td className="border-b border-ink-800 py-2.5 pr-3 text-ink-200">
                {QUALITY_LABEL[q] ?? q}
                <span className="ml-1.5 text-[11px] text-ink-500">
                  {resolutionFor(model, q)}
                </span>
              </td>
              {columns.map((c, i) => (
                <td
                  key={c.label}
                  className={`border-b border-ink-800 py-2.5 text-right tabular-nums text-ink-300 ${
                    i === columns.length - 1 ? "pl-3" : "px-3"
                  }`}
                >
                  {creditLabel(priceFor(q, c.secs, c.audio))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
