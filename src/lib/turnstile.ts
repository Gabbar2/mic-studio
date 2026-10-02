/**
 * Cloudflare Turnstile — shared constants.
 *
 * The site key is public by design; it is the *secret* key that goes into
 * Supabase's Attack Protection page and nowhere near this repository.
 *
 * Everything here degrades to nothing when the key is absent. That is
 * deliberate: the app has to keep working on a branch, a preview deployment,
 * or a local machine where nobody has set the variable.
 */
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

export const TURNSTILE_ENABLED = TURNSTILE_SITE_KEY.length > 0;

/** How long to wait for a token before giving up and letting the call through. */
export const TURNSTILE_TIMEOUT_MS = 15_000;
