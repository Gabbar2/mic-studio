import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { findPack, findSubscriptionPlan } from "@/lib/credits";
import {
  polarApiBase,
  polarApiVersion,
  polarConfigured,
  productIdFor,
  subscriptionProductIdFor,
} from "@/lib/polar";
import { isUAEVisitorBlocked } from "@/lib/geo";

export const runtime = "nodejs";

/**
 * Creates a Polar checkout session for a credit pack and hands the hosted
 * checkout URL back. The browser redirects the customer there — Polar's
 * checkout is a hosted page, not an in-page overlay like Paddle's.
 *
 * Doing this server-side, rather than letting the page open a checkout
 * against a product id directly, means `metadata` is written here, where the
 * user id comes from a verified session rather than from whatever the client
 * claims.
 *
 * A checkout session is not a payment. Nothing is charged until the customer
 * completes it, and nothing is credited until the signed `order.paid` webhook
 * arrives — see api/webhooks/polar.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // An anonymous trial account has no email and no way to recover a purchase
  // if the cookie is lost. Selling credits into an account that can vanish
  // with a cleared cookie would be taking money for something we cannot
  // reliably give back.
  if (user.is_anonymous === true || !user.email) {
    return NextResponse.json(
      {
        error: "Add your email before buying credits.",
        code: "email_required",
      },
      { status: 403 },
    );
  }

  // UAE checkout is paused while the operator's local licensing question is
  // unresolved (see lib/geo.ts). Best-effort IP geolocation, fails open.
  // Temporarily lifted when UAE_BLOCK_SUSPENDED_UNTIL is set and in the
  // future — see isUAEVisitorBlocked's doc comment for how to use that.
  if (isUAEVisitorBlocked(req)) {
    return NextResponse.json(
      {
        error: "Purchases aren't available in the UAE yet.",
        code: "region_unavailable",
      },
      { status: 403 },
    );
  }

  const apiKey = process.env.POLAR_ACCESS_TOKEN;
  if (!apiKey || !polarConfigured()) {
    return NextResponse.json(
      { error: "Payments are not configured yet." },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));

  // Either a one-off pack (`packId`) or a recurring plan (`planId`) — never
  // both. The two share everything below this point: same auth checks, same
  // Polar checkout call, same webhook. Polar tells subscription and one-time
  // products apart on its own side (the product itself is configured as
  // recurring or not), so nothing here needs a "mode" flag.
  const pack = body.packId ? findPack(String(body.packId)) : undefined;
  const plan = body.planId ? findSubscriptionPlan(String(body.planId)) : undefined;

  if (!pack && !plan) {
    return NextResponse.json({ error: "Unknown pack or plan" }, { status: 400 });
  }

  const productId = pack ? productIdFor(pack.id) : subscriptionProductIdFor(plan!.id);
  if (!productId) {
    console.error(
      "[polar] no product id configured for",
      pack?.id ?? plan?.id,
    );
    return NextResponse.json(
      { error: "That option is unavailable right now." },
      { status: 503 },
    );
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  const res = await fetch(`${polarApiBase()}/checkouts/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Pin the contract explicitly — see polarApiVersion() for why.
      "Polar-Version": polarApiVersion(),
    },
    body: JSON.stringify({
      products: [productId],
      customer_email: user.email,
      success_url: `${siteUrl}/studio?${plan ? "subscribed" : "topup"}=success`,
      // Read back by the webhook to know whose balance to credit. The credit
      // *amount* is deliberately not taken from here — the webhook resolves
      // it from the product id instead, so tampered metadata cannot mint
      // credit. Polar carries this same metadata onto the subscription object
      // (and, per Polar, onto the orders it later generates for renewals),
      // which is what lets the webhook attribute a renewal order back to this
      // user without a fresh checkout.
      metadata: pack
        ? { user_id: user.id, pack_id: pack.id }
        : { user_id: user.id, plan_id: plan!.id },
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.url) {
    console.error("[polar] checkout failed", res.status, json);
    return NextResponse.json(
      { error: "Could not start checkout. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ checkoutUrl: json.url as string });
}
