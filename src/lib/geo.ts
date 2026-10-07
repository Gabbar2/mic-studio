/**
 * Best-effort visitor country, from edge-added request headers.
 *
 * This exists for exactly one purpose right now: keeping UAE customers out of
 * checkout while the operator's UAE licensing question is unresolved (see the
 * conversation this shipped from — selling into the UAE without a trade or
 * freelance licence is the specific risk being avoided).
 *
 * It is IP-based geolocation, so it is a *reasonable-effort* filter, not a
 * guarantee — a VPN or proxy defeats it, same as every geo-block on the web.
 * That is the accepted standard for this kind of control; it is not trying to
 * be stronger than that.
 *
 * Fails open on purpose: if neither header is present (local dev, or an
 * edge/proxy configuration that doesn't set them), the visitor is treated as
 * unknown rather than blocked. A missing signal should never be the reason a
 * real customer elsewhere in the world can't buy credits.
 */
export function visitorCountry(req: Request): string | null {
  // Vercel's edge network sets this on every request that reaches it.
  const vercel = req.headers.get("x-vercel-ip-country");
  if (vercel) return vercel.toUpperCase();

  // Cloudflare sets this instead, if the domain is proxied through it rather
  // than hitting Vercel's edge directly.
  const cf = req.headers.get("cf-ipcountry");
  if (cf && cf !== "XX") return cf.toUpperCase();

  return null;
}

export function isUAEVisitor(req: Request): boolean {
  return visitorCountry(req) === "AE";
}

/**
 * A short, self-expiring way to test checkout from inside the UAE without
 * touching the block's actual logic above or needing a second deploy to
 * turn it back on.
 *
 * Set UAE_BLOCK_SUSPENDED_UNTIL in Vercel (an ISO timestamp, e.g. the output
 * of `new Date(Date.now() + 30*60*1000).toISOString()`) and redeploy once.
 * The block stays off until that moment, then silently resumes on its own —
 * nobody has to remember to flip anything back. Leaving the var unset or
 * removing it re-enables the block immediately.
 */
function isUAEBlockSuspended(): boolean {
  const until = process.env.UAE_BLOCK_SUSPENDED_UNTIL;
  if (!until) return false;
  const untilMs = Date.parse(until);
  return Number.isFinite(untilMs) && Date.now() < untilMs;
}

export function isUAEVisitorBlocked(req: Request): boolean {
  return isUAEVisitor(req) && !isUAEBlockSuspended();
}
