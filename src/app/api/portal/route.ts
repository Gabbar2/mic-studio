import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { polarApiBase, polarApiVersion, polarConfigured } from "@/lib/polar";

export const runtime = "nodejs";

/**
 * Hands back a one-time link into Polar's hosted customer portal, where a
 * subscriber manages or cancels their own plan.
 *
 * This app never builds its own cancel/change-plan UI — Polar's portal
 * already handles proration, payment method updates and invoices, and
 * duplicating that here would be a second place for it to go stale. A
 * customer session token is single-use and short-lived, so it's minted fresh
 * on every click rather than cached.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const apiKey = process.env.POLAR_ACCESS_TOKEN;
  if (!apiKey || !polarConfigured()) {
    return NextResponse.json(
      { error: "Payments are not configured yet." },
      { status: 503 },
    );
  }

  const admin = createAdminClient();

  // The most recent subscription row for this user, regardless of status —
  // a canceled or past_due subscription still needs a portal link (to see
  // the final invoice, or to resubscribe).
  const { data: sub } = await admin
    .from("subscriptions")
    .select("polar_customer_id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub?.polar_customer_id) {
    return NextResponse.json(
      { error: "No subscription found for this account." },
      { status: 404 },
    );
  }

  const res = await fetch(`${polarApiBase()}/customer-sessions/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Polar-Version": polarApiVersion(),
    },
    body: JSON.stringify({ customer_id: sub.polar_customer_id }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.customer_portal_url) {
    console.error("[polar] customer session failed", res.status, json);
    return NextResponse.json(
      { error: "Could not open the billing portal. Please try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ portalUrl: json.customer_portal_url as string });
}
