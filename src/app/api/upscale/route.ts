import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeProvider } from "@/lib/providers";
import { ProviderError } from "@/lib/providers/types";
import {
  UPSCALE_FACTOR,
  isUpscaleTarget,
  upscaleChargeCents,
  upscaleCostCents,
} from "@/lib/upscale";
import { refundGeneration, tryDebit } from "@/lib/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  generationId: z.string().uuid(),
  target: z.enum(["2k", "4k"]),
});

/**
 * Upscales one finished clip.
 *
 * On-demand rather than automatic: you only pay for the takes you keep. On a
 * 60-clip job with a 2.5x retry rate, upscaling everything instead of the
 * keepers would waste roughly $70.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const { generationId, target } = parsed.data;
  if (!isUpscaleTarget(target)) {
    return NextResponse.json({ error: "Unknown target" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: row } = await admin
    .from("generations")
    .select(
      "id, user_id, status, video_url, duration_seconds, duration_actual, upscale_status",
    )
    .eq("id", generationId)
    .maybeSingle();

  // Same 404 for "not found" and "not yours" — an owner check that answers
  // differently is an enumeration oracle.
  if (!row || row.user_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (row.status !== "succeeded" || !row.video_url) {
    return NextResponse.json(
      { error: "Only a finished clip can be upscaled." },
      { status: 400 },
    );
  }

  if (row.upscale_status === "queued" || row.upscale_status === "processing") {
    return NextResponse.json(
      { error: "An upscale is already running for this clip." },
      { status: 409 },
    );
  }

  const provider = activeProvider();
  if (!provider.upscale) {
    return NextResponse.json(
      { error: `Upscaling is not available on the ${provider.name} provider.` },
      { status: 400 },
    );
  }

  const seconds = row.duration_actual ?? row.duration_seconds;
  const costCents = upscaleCostCents(seconds);
  const chargeCents = upscaleChargeCents(seconds);

  // Claim the slot before calling out, so a double-click cannot start two jobs.
  const { error: claimError } = await admin
    .from("generations")
    .update({
      upscale_status: "queued",
      upscale_target: target,
      upscale_cost_cents: costCents,
      upscale_charged_cents: chargeCents,
      upscale_error: null,
      upscale_url: null,
      upscale_task_id: null,
      upscale_completed_at: null,
    })
    .eq("id", row.id)
    .or("upscale_status.is.null,upscale_status.in.(succeeded,failed)");

  if (claimError) {
    return NextResponse.json({ error: claimError.message }, { status: 500 });
  }

  // Charge before calling out, and give it straight back if the provider
  // refuses — same contract as a generation.
  const paid = await tryDebit(user.id, chargeCents, row.id, "upscale");
  if (!paid) {
    await admin
      .from("generations")
      .update({
        upscale_status: null,
        upscale_target: null,
        upscale_cost_cents: null,
        upscale_charged_cents: null,
      })
      .eq("id", row.id);
    return NextResponse.json(
      { error: "Not enough credits for this upscale.", code: "insufficient_credit" },
      { status: 402 },
    );
  }

  try {
    const task = await provider.upscale({
      videoUrl: row.video_url,
      factor: UPSCALE_FACTOR[target],
      callbackUrl: undefined,
    });

    const { data: updated } = await admin
      .from("generations")
      .update({ upscale_task_id: task.taskId, upscale_status: task.status })
      .eq("id", row.id)
      .select("*")
      .single();

    return NextResponse.json({ generation: updated });
  } catch (e) {
    const message =
      e instanceof ProviderError ? e.message : "Could not start the upscale.";

    await refundGeneration(user.id, row.id, chargeCents, message);

    await admin
      .from("generations")
      .update({
        upscale_status: "failed",
        upscale_error: message,
        upscale_cost_cents: null,
        upscale_charged_cents: null,
      })
      .eq("id", row.id);

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
