import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { activeProvider } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remaining credit at the active provider.
 *
 * Always 200 — a null balance means "we couldn't determine it" (provider has no
 * balance API, or the key isn't admin-scoped). The header renders nothing in
 * that case rather than showing an error, because not knowing your balance is
 * not a failure of the app.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const provider = activeProvider();
  if (!provider.getBalance) {
    return NextResponse.json({ balance: null, provider: provider.name });
  }

  const result = await provider.getBalance();

  return NextResponse.json({
    balance: result?.balance ?? null,
    currency: result?.currency ?? "USD",
    provider: provider.name,
  });
}
