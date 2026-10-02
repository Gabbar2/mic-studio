import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { creditBalance, ensureSignupGrant, CREDIT_PACKS } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Balance plus recent ledger entries, for the account panel. */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  await ensureSignupGrant(
    user.id,
    user.is_anonymous === true,
    user.email ? { email: user.email } : undefined,
  );

  const admin = createAdminClient();
  const [balance, { data: entries }] = await Promise.all([
    creditBalance(user.id),
    admin
      .from("credit_ledger")
      .select("id, amount_cents, reason, note, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  return NextResponse.json({
    balanceCents: balance,
    entries: entries ?? [],
    packs: CREDIT_PACKS,
  });
}
