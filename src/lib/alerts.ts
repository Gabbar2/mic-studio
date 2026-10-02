import { usd } from "./format";

/**
 * Operator alerts.
 *
 * Sent through Resend's HTTP API rather than the Supabase SMTP path, because
 * these are not auth emails: they must go out even when nobody is signed in,
 * and they must not consume the auth rate limit that protects sign-in links.
 *
 * Silent no-op when unconfigured. An alerting system that crashes the job it
 * is attached to is worse than no alerting at all — the cron's real work is
 * polling generations, and that must not fail because a mail key is missing.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function config() {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from = process.env.ALERT_FROM ?? "alerts@micstudio.app";
  if (!apiKey || !to) return null;
  return { apiKey, to, from };
}

export function alertsConfigured(): boolean {
  return config() !== null;
}

/** Cents below which the operator wants to hear about it. Default $10. */
export function lowBalanceThresholdCents(): number {
  const raw = Number(process.env.FAL_LOW_BALANCE_CENTS ?? 1000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1000;
}

async function send(subject: string, lines: string[]): Promise<boolean> {
  const c = config();
  if (!c) return false;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Mic Studio <${c.from}>`,
        to: [c.to],
        subject,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) {
      console.error("[alerts] resend refused", res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[alerts] send failed", e);
    return false;
  }
}

/**
 * The one alert that matters: fal is running out while customers hold credits
 * they have already paid for.
 *
 * The subject line carries the number, because that is all you can see on a
 * phone's lock screen and it is enough to decide whether to act now.
 */
export async function sendLowBalanceAlert(opts: {
  balanceCents: number;
  liabilityProviderCents: number;
  thresholdCents: number;
}): Promise<boolean> {
  const { balanceCents, liabilityProviderCents, thresholdCents } = opts;
  const short = liabilityProviderCents - balanceCents;
  const clips = Math.floor(balanceCents / 84);

  return send(`fal balance is ${usd(balanceCents)} — top up`, [
    `Your fal balance has dropped to ${usd(balanceCents)}, below the ${usd(thresholdCents)} threshold.`,
    "",
    `That is roughly ${clips} more Standard 10s clips.`,
    "",
    `Customers currently hold credit worth ${usd(liabilityProviderCents)} of fal usage.`,
    short > 0
      ? `You are SHORT by ${usd(short)} if everyone spends what they hold.`
      : `You are covered for what has been sold.`,
    "",
    "Top up: https://fal.ai/dashboard/billing",
    "",
    "Until you do, new generations are refused politely rather than failing",
    "part-way through, and nobody is charged for a clip that cannot be made.",
  ]);
}
