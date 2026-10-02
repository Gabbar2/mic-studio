import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePolarProduct, verifyPolarSignature } from "@/lib/polar";

export const runtime = "nodejs";

type PolarOrder = {
  id?: string;
  product_id?: string;
  subscription_id?: string | null;
  metadata?: { user_id?: string; pack_id?: string; plan_id?: string } | null;
};

type PolarSubscription = {
  id?: string;
  status?: string;
  product_id?: string;
  customer_id?: string;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  metadata?: { user_id?: string; plan_id?: string } | null;
};

/**
 * Polar webhook — the only place credit is granted from a payment, and the
 * only place `public.subscriptions` is written.
 *
 * Never trust the browser's return from checkout: anyone can land on
 * ?topup=success or ?subscribed=success without having paid. The signed
 * webhook is the fact.
 *
 * Polar retries up to 10 times with backoff on a non-2xx response, so this
 * must be idempotent. The unique index on credit_ledger.polar_order_id does
 * that job for credit grants — a duplicate delivery hits a constraint
 * violation and is swallowed. Subscription-row writes are upserts, which are
 * naturally idempotent on their own.
 *
 * Only `order.paid` grants credit. `order.created` fires earlier and does not
 * mean money has actually moved (see `billing_reason` in Polar's docs); an
 * order only reaches `order.paid` once payment succeeded. For a subscription
 * this fires once at signup and again on every renewal — each with a new
 * order id, so renewals credit correctly without any extra logic here.
 */
export async function POST(req: Request) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  // Raw body, byte for byte. Reading it as JSON first and re-serialising it
  // would change whitespace and break the signature.
  const raw = await req.text();

  const verified = verifyPolarSignature(
    raw,
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    secret,
  );

  if (!verified) {
    console.error("[polar] bad signature");
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  let event: { type?: string; data?: PolarOrder & PolarSubscription };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Bad body" }, { status: 400 });
  }

  const admin = createAdminClient();

  if (event.type === "order.paid") {
    return handleOrderPaid(admin, event.data as PolarOrder);
  }

  if (
    event.type === "subscription.created" ||
    event.type === "subscription.updated" ||
    event.type === "subscription.active" ||
    event.type === "subscription.canceled" ||
    event.type === "subscription.uncanceled" ||
    event.type === "subscription.revoked"
  ) {
    return handleSubscriptionEvent(admin, event.data as PolarSubscription);
  }

  // Acknowledge everything else. Returning an error for events we do not act
  // on would make Polar retry them and eventually disable the endpoint.
  return NextResponse.json({ received: true });
}

async function handleOrderPaid(
  admin: ReturnType<typeof createAdminClient>,
  order: PolarOrder | undefined,
) {
  const orderId = order?.id;
  if (!orderId) {
    console.error("[polar] order.paid with no order id");
    return NextResponse.json({ received: true });
  }

  // The credit amount and its kind (pack vs. plan) come from the product id,
  // never from the payload's figures. Tampered metadata cannot mint credit,
  // and a price edited in the Polar dashboard changes what someone pays but
  // not what they get.
  const productId = order?.product_id;
  const resolved = productId ? resolvePolarProduct(productId) : null;

  if (!resolved) {
    console.error(
      "[polar] unrecognised product id — is POLAR_PRODUCT_PACK_*/POLAR_PRODUCT_SUB_* set for this environment?",
      { orderId, productId },
    );
    // 500 so Polar retries: this is our misconfiguration, and the customer
    // has paid. Retrying gives us a window to fix the variable and have the
    // credit land without anyone having to chase it.
    return NextResponse.json({ error: "Unknown product" }, { status: 500 });
  }

  // A checkout's own metadata carries user_id straight through on the first
  // order. A renewal order is minted by Polar itself with no fresh checkout,
  // so as a defence against that metadata not propagating (Polar's docs say
  // it does, but this costs nothing to guard), fall back to the subscription
  // row this app already wrote from the subscription.* events below.
  let userId = order?.metadata?.user_id;
  if (!userId && order?.subscription_id) {
    const { data: sub } = await admin
      .from("subscriptions")
      .select("user_id")
      .eq("id", order.subscription_id)
      .maybeSingle();
    userId = sub?.user_id;
  }

  if (!userId) {
    console.error("[polar] order missing user_id", orderId);
    return NextResponse.json({ received: true });
  }

  const { error } = await admin.from("credit_ledger").insert({
    user_id: userId,
    amount_cents: resolved.creditCents,
    reason: resolved.kind === "subscription" ? "subscription" : "purchase",
    polar_order_id: orderId,
    note:
      resolved.kind === "subscription"
        ? `Polar subscription ${resolved.id} — order ${orderId}`
        : `Polar ${orderId}`,
  });

  // 23505 = unique violation, i.e. this order was already credited.
  if (error && error.code !== "23505") {
    console.error("[polar] credit failed", error);
    return NextResponse.json({ error: "Credit failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleSubscriptionEvent(
  admin: ReturnType<typeof createAdminClient>,
  sub: PolarSubscription | undefined,
) {
  const subscriptionId = sub?.id;
  if (!subscriptionId) {
    console.error("[polar] subscription event with no subscription id");
    return NextResponse.json({ received: true });
  }

  const productId = sub?.product_id;
  const resolved = productId ? resolvePolarProduct(productId) : null;
  const planId = resolved?.kind === "subscription" ? resolved.id : null;

  // user_id is only present on the events Polar fires close to checkout,
  // where it still carries the metadata this app set. A later event (e.g. a
  // renewal's subscription.updated) may omit it — in which case the existing
  // row's user_id is left untouched by the upsert below rather than wiped.
  const userId = sub?.metadata?.user_id;

  if (!userId) {
    // Nothing to attribute this row to yet, and no existing row to update
    // blindly (upserting without user_id would violate the not-null
    // constraint). Safe to skip — a later event for the same subscription id
    // (or the order.paid fallback lookup) fills it in.
    return NextResponse.json({ received: true });
  }

  const { error } = await admin.from("subscriptions").upsert(
    {
      id: subscriptionId,
      user_id: userId,
      plan_id: planId,
      status: sub?.status ?? "unknown",
      polar_customer_id: sub?.customer_id ?? null,
      current_period_end: sub?.current_period_end ?? null,
      cancel_at_period_end: sub?.cancel_at_period_end ?? false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) {
    console.error("[polar] subscription upsert failed", error);
    return NextResponse.json({ error: "Subscription sync failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
