import { NextResponse } from "next/server";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Stripe webhook — the only place credit is granted from a payment.
 *
 * Never trust the browser's return from Checkout: a user can land on
 * ?topup=success without having paid. The signed webhook is the fact.
 *
 * Stripe retries on failure, so this must be idempotent. The unique index on
 * credit_ledger.stripe_session_id does that job — a duplicate delivery hits a
 * constraint violation and is swallowed.
 */
export async function POST(req: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!key || !secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const stripe = new Stripe(key);
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret);
  } catch (e) {
    console.error("[stripe] bad signature", e);
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") {
    return NextResponse.json({ received: true });
  }

  const userId = session.metadata?.user_id;
  const cents = Number(session.metadata?.credit_cents ?? 0);

  if (!userId || !Number.isFinite(cents) || cents <= 0) {
    console.error("[stripe] session missing metadata", session.id);
    return NextResponse.json({ received: true });
  }

  const admin = createAdminClient();
  const { error } = await admin.from("credit_ledger").insert({
    user_id: userId,
    amount_cents: cents,
    reason: "purchase",
    stripe_session_id: session.id,
    note: `Stripe ${session.id}`,
  });

  // 23505 = unique violation, i.e. this session was already credited.
  if (error && error.code !== "23505") {
    console.error("[stripe] credit failed", error);
    return NextResponse.json({ error: "Credit failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
