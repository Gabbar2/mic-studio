import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { providerFor } from "@/lib/providers";
import { applyTaskUpdate } from "@/lib/generations";
import { applyUpscaleUpdate } from "@/lib/upscaleJobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the caller's recent generations.
 *
 * Before responding it opportunistically refreshes any in-flight job straight
 * from its provider. This is what makes the app work correctly on localhost,
 * where webhooks cannot reach you — the UI polls this endpoint, and the
 * endpoint polls the provider. In production the webhook usually wins the race
 * and this is a no-op.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50),
    100,
  );

  const admin = createAdminClient();

  const { data: pending } = await admin
    .from("generations")
    .select("id, provider, provider_task_id, mode, quality, model_id")
    .eq("user_id", user.id)
    .in("status", ["queued", "processing"])
    .not("provider_task_id", "is", null)
    .limit(10);

  // Upscales are a second job class on the same rows, with their own queue
  // namespace at the provider — so they need their own sweep.
  const { data: pendingUpscales } = await admin
    .from("generations")
    .select("provider, upscale_task_id")
    .eq("user_id", user.id)
    .in("upscale_status", ["queued", "processing"])
    .not("upscale_task_id", "is", null)
    .limit(10);

  await Promise.allSettled([
    ...(pending ?? []).map(async (p) => {
      const provider = providerFor(p.provider, p.provider_task_id!);
      const task = await provider.get(
        p.provider_task_id!,
        p.mode,
        p.quality,
        p.model_id,
      );
      await applyTaskUpdate(p.provider_task_id!, task);
    }),
    ...(pendingUpscales ?? []).map(async (p) => {
      const provider = providerFor(p.provider, p.upscale_task_id!);
      if (!provider.getUpscale) return;
      const task = await provider.getUpscale(p.upscale_task_id!);
      await applyUpscaleUpdate(p.upscale_task_id!, task);
    }),
  ]);

  const [{ data, error }, { data: spendRows }] = await Promise.all([
    admin
      .from("generations")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit),
    admin.rpc("spend_summary", { p_user: user.id }),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Aggregated in SQL rather than summed from `data`, which is capped at
  // `limit` — a client-side total would silently drift once you pass 50 clips.
  const row = Array.isArray(spendRows) ? spendRows[0] : spendRows;

  return NextResponse.json({
    generations: data ?? [],
    spend: {
      todayCents: row?.today_cents ?? 0,
      totalCents: row?.total_cents ?? 0,
    },
  });
}
