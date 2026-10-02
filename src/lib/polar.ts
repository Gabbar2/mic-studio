import { createHmac, timingSafeEqual } from "node:crypto";
import {
  CREDIT_PACKS,
  SUBSCRIPTION_PLANS,
  type CreditPackId,
  type SubscriptionPlanId,
} from "./credits";

/**
 * Polar — merchant of record, replacing the Paddle integration that never
 * shipped (Paddle rejected the application before any live payment; see the
 * git history on `paddle.ts` if that ever needs revisiting).
 *
 * Same shape as Paddle, deliberately: Polar sells to the customer, collects
 * tax, and pays us a share. Card details never reach this app. The one
 * structural difference is that Polar has no separate "price id" layer —
 * each pack is its own **product**, and the product id is what a checkout
 * references and what a webhook reports back.
 */

export type PolarEnv = "sandbox" | "production";

export function polarEnv(): PolarEnv {
  return process.env.NEXT_PUBLIC_POLAR_ENV === "production"
    ? "production"
    : "sandbox";
}

/** Sandbox and production are entirely separate systems with separate ids. */
export function polarApiBase(): string {
  return polarEnv() === "production"
    ? "https://api.polar.sh/v1"
    : "https://sandbox-api.polar.sh/v1";
}

/**
 * The API contract this integration was built and tested against, sent as
 * the `Polar-Version` header on every request.
 *
 * Polar runs three concurrent versions (Current / Deprecated / Next) and a
 * request that omits this header silently rides Current — which changes at
 * every quarterly release (Jan/Apr/Jul/Oct). Pinning it means a Polar
 * release never changes this app's behaviour out from under it; upgrading
 * is then a deliberate step (bump this, then test against the new version)
 * rather than something that happens to you on a release date.
 */
export function polarApiVersion(): string {
  return process.env.POLAR_API_VERSION?.trim() || "2026-04";
}

export function polarConfigured(): boolean {
  return (
    Boolean(process.env.POLAR_ACCESS_TOKEN) && productIdFor("pack_10") !== null
  );
}

/**
 * Our pack id to Polar's product id.
 *
 * Kept in environment variables rather than the database, same reasoning as
 * Paddle: sandbox and production have different ids, and a deploy already
 * carries per-environment config. A product id is not secret — it is visible
 * the moment a checkout page loads.
 */
const PRODUCT_ENV: Record<CreditPackId, string> = {
  pack_10: "POLAR_PRODUCT_PACK_10",
  pack_25: "POLAR_PRODUCT_PACK_25",
  pack_50: "POLAR_PRODUCT_PACK_50",
};

export function productIdFor(packId: CreditPackId): string | null {
  const raw = process.env[PRODUCT_ENV[packId]];
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * Same mapping as PRODUCT_ENV, for the two recurring products. Kept as a
 * separate table rather than merged into PRODUCT_ENV — packs and plans are
 * different id spaces (CreditPackId vs SubscriptionPlanId) and a merged table
 * would need a runtime check to tell them apart everywhere it's read.
 */
const SUBSCRIPTION_PRODUCT_ENV: Record<SubscriptionPlanId, string> = {
  sub_monthly: "POLAR_PRODUCT_SUB_MONTHLY",
  sub_yearly: "POLAR_PRODUCT_SUB_YEARLY",
};

export function subscriptionProductIdFor(
  planId: SubscriptionPlanId,
): string | null {
  const raw = process.env[SUBSCRIPTION_PRODUCT_ENV[planId]];
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * How much credit a Polar product grants, and whether it came from a
 * one-off pack or a recurring plan.
 *
 * This is the security boundary of the whole integration, same as Paddle's
 * `creditCentsForPrice`. The webhook must never take the credit amount from
 * anything the checkout payload claims — not `metadata`, not the order total.
 * It resolves the product id Polar itself reports back to one of our own
 * packs or plans, and reads the credit figure from that definition.
 *
 * Consequence: editing a product's price in the Polar dashboard changes what
 * the customer pays but not what they receive. Safe direction to fail — but
 * it means prices must be changed in both places or neither.
 */
export function resolvePolarProduct(productId: string): {
  kind: "pack" | "subscription";
  id: CreditPackId | SubscriptionPlanId;
  creditCents: number;
} | null {
  for (const pack of CREDIT_PACKS) {
    if (productIdFor(pack.id) === productId) {
      return { kind: "pack", id: pack.id, creditCents: pack.creditCents };
    }
  }
  for (const plan of SUBSCRIPTION_PLANS) {
    if (subscriptionProductIdFor(plan.id) === productId) {
      return {
        kind: "subscription",
        id: plan.id,
        creditCents: plan.creditCents,
      };
    }
  }
  return null;
}

/** @deprecated Use `resolvePolarProduct` — kept only so nothing else breaks. */
export function creditCentsForProduct(productId: string): number | null {
  return resolvePolarProduct(productId)?.creditCents ?? null;
}

/**
 * Verifies a Polar webhook per the Standard Webhooks spec
 * (https://github.com/standard-webhooks/standard-webhooks).
 *
 * Three headers carry the proof: `webhook-id`, `webhook-timestamp`, and
 * `webhook-signature`. The signed content is `${id}.${timestamp}.${rawBody}`
 * — the *raw* body, byte for byte; parsing the JSON and re-serialising it
 * changes whitespace and the signature fails.
 *
 * The secret arrives as `whsec_<base64>`. The spec signs with the
 * base64-decoded bytes after that prefix, not the string itself.
 *
 * `webhook-signature` can carry more than one space-separated signature
 * (each `v1,<base64>`) when a secret was recently rotated — any match is
 * accepted, mirroring Svix's own verification behaviour.
 *
 * Returns false rather than throwing, so a malformed header is a 400 and not
 * a 500 — a crash here would make the endpoint look broken to Polar's retry
 * logic and risk it being disabled after repeated failures.
 */
export function verifyPolarSignature(
  rawBody: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  secret: string,
  maxAgeSeconds = 300,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > maxAgeSeconds) return false;

  const key = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const part of signature.split(" ")) {
    const [scheme, value] = part.split(",");
    if (scheme !== "v1" || !value) continue;

    const candidate = Buffer.from(value, "utf8");
    if (candidate.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidate, expectedBuf)) return true;
  }

  return false;
}
