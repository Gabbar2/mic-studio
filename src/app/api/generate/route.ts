import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { providerBalanceCentsFresh } from "@/lib/appState";
import { checkTrialShape, trialBudgetSpent } from "@/lib/anon";
import { checkFreeTierShape } from "@/lib/freeTier";
import {
  chargeForProviderCost,
  creditBalance,
  ensureSignupGrant,
  isUnlockedAccount,
  priceMarkup,
  refundGeneration,
  tryDebit,
} from "@/lib/credits";
import { activeProvider, ProviderError } from "@/lib/providers";
import {
  durationsFor,
  effectiveMarkup,
  estimateCostCents,
  getModel,
  imageReferenceBudget,
} from "@/lib/models";

/**
 * Fallback used only when a reference video is attached to an
 * additive-billing model (Wan 3.0) but the client didn't report a duration —
 * stale/old client code, or the probe in MediaDrop failing silently. Rather
 * than charge 0 extra seconds (undercharging relative to what fal actually
 * bills — exactly the risk this whole feature exists to avoid), this assumes
 * the worst case the model allows, so the business is never short.
 */
const UNREPORTED_REFERENCE_VIDEO_DURATION_SECONDS = 15;

export const runtime = "nodejs";

const Body = z.object({
  modelId: z.string(),
  mode: z.enum(["text2video", "image2video", "reference2video"]),
  prompt: z.string().min(3).max(2500),
  negativePrompt: z.string().max(2500).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  durationSeconds: z.number().int(),
  quality: z.enum(["std", "pro", "4k"]),
  cfgScale: z.number().min(0).max(1).default(0.5),
  withAudio: z.boolean().default(false),
  imageUrl: z.string().url().optional(),
  endImageUrl: z.string().url().optional(),
  referenceVideoUrl: z.string().url().optional(),
  // The real per-model cap (4 for Kling and Wan 2.7, 10 for Wan 3.0) is
  // enforced below via imageReferenceBudget(model), once the model is known.
  // This is just an outer sanity bound against the largest any model offers.
  referenceImageUrls: z.array(z.string().url()).max(10).optional(),
  /**
   * The reference video's own length, measured client-side (see MediaDrop's
   * duration probe). Only read for a model billed "additive" — see the
   * clamp below. This is client-reported, not independently re-measured from
   * the file here, so a user who edits the request by hand could under-report
   * it to shave a little off an additive-billing job's price; the clamp below
   * bounds how much that's worth (at most the model's own
   * maxReferenceVideoUploadSeconds), and the "missing" fallback charges the
   * worst case rather than zero, so neither path can badly undercharge
   * relative to what fal actually bills.
   */
  referenceVideoDurationSeconds: z.number().min(0).max(60).optional(),
});

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
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const model = getModel(input.modelId);
  if (!model) {
    return NextResponse.json({ error: "Unknown model" }, { status: 400 });
  }
  if (!model.modes.includes(input.mode)) {
    return NextResponse.json(
      { error: `${model.label} does not support ${input.mode}` },
      { status: 400 },
    );
  }
  // Reference mode with a reference *video* runs on a different endpoint
  // (O1 video-to-video) than reference mode with only images (O3), and O1
  // caps out at 10s where everything else goes to 15 — see durationsFor.
  const allowedDurations = durationsFor(
    model,
    input.mode,
    !!input.referenceVideoUrl,
  );
  if (!allowedDurations.includes(input.durationSeconds)) {
    return NextResponse.json(
      { error: `Duration must be one of ${allowedDurations.join(", ")}s` },
      { status: 400 },
    );
  }
  // Supabase marks trial visitors with is_anonymous on the JWT. Everything
  // below branches on this and on the account's tier.
  const isAnonymous = user.is_anonymous === true;
  const unlocked = !isAnonymous && (await isUnlockedAccount(user.id));

  await ensureSignupGrant(
    user.id,
    isAnonymous,
    user.email ? { email: user.email } : undefined,
  );

  // Only meaningful for a model billed "additive" (Wan 3.0 today) — see
  // ModelDef.referenceVideoBilling. Clamped to the model's own upload cap (15s
  // for Wan 3.0) rather than trusted verbatim, and a missing/zero value when a
  // video IS attached falls back to that same cap rather than 0 seconds — the
  // safe direction to be wrong in is overcharging a few hundred credits, not
  // under-billing a request fal will bill for real. See the Body schema
  // comment above for the fuller reasoning.
  const referenceVideoDurationSeconds =
    input.mode === "reference2video" &&
    input.referenceVideoUrl &&
    model.referenceVideoBilling === "additive"
      ? Math.min(
          input.referenceVideoDurationSeconds ||
            model.maxReferenceVideoUploadSeconds ||
            UNREPORTED_REFERENCE_VIDEO_DURATION_SECONDS,
          model.maxReferenceVideoUploadSeconds ??
            UNREPORTED_REFERENCE_VIDEO_DURATION_SECONDS,
        )
      : 0;

  // Computed up front (moved ahead of the free-tier check below) so a
  // free-tier account whose balance already covers this exact request can be
  // let through on that alone, rather than refused on shape for a request
  // they can actually pay for. The real floor — can they afford it right
  // now, this instant — is still enforced the normal way further down, by
  // the debit itself; this is only about which account tiers may even try.
  const providerCents = estimateCostCents(
    model,
    input.mode,
    input.quality,
    input.durationSeconds,
    input.withAudio && model.supportsAudio,
    !!input.referenceVideoUrl,
    referenceVideoDurationSeconds,
  );
  const chargedCents = chargeForProviderCost(
    providerCents,
    effectiveMarkup(model, priceMarkup()),
  );

  // --- the free clip / the free tier's caps --------------------------------
  // Refuse on shape before the mode-specific checks below, so a trial visitor
  // who picked Pro — or a signed-up-but-unpaid account reaching for Reference
  // mode — is told what their tier allows rather than being asked for a start
  // frame or a reference video they were never going to be allowed to submit.
  if (isAnonymous) {
    const violation = checkTrialShape({
      mode: input.mode,
      quality: input.quality,
      durationSeconds: input.durationSeconds,
      withAudio: input.withAudio && model.supportsAudio,
      modelId: input.modelId,
    });
    if (violation) {
      return NextResponse.json(
        { error: violation.message, code: "trial_shape" },
        { status: 403 },
      );
    }
  } else if (!unlocked) {
    const availableCents = await creditBalance(user.id);
    const violation = checkFreeTierShape(
      {
        mode: input.mode,
        quality: input.quality,
        durationSeconds: input.durationSeconds,
      },
      { availableCents, requiredCents: chargedCents },
    );
    if (violation) {
      return NextResponse.json(
        { error: violation.message, code: "tier_locked", lock: violation.lock },
        { status: 403 },
      );
    }
  }

  if (input.mode === "image2video" && !input.imageUrl) {
    return NextResponse.json(
      { error: "A start frame is required for image-to-video" },
      { status: 400 },
    );
  }

  if (input.mode === "reference2video" && input.quality === "4k") {
    return NextResponse.json(
      { error: "4K is not available in reference mode." },
      { status: 400 },
    );
  }

  const referenceImages = input.referenceImageUrls ?? [];

  if (input.mode === "reference2video") {
    // Only Kling's reference endpoint accepts an uploaded reference *video*
    // (see ModelDef.supportsReferenceVideo) — the composer never renders that
    // dropzone for any other model, so this should be unreachable, but it's
    // checked here with a clean 400 rather than left to surface as a 500 out
    // of the provider adapter's own defensive rejection.
    if (input.referenceVideoUrl && !model.supportsReferenceVideo) {
      return NextResponse.json(
        {
          error: `${model.label} doesn't support a video reference — use Kling, or remove the video and keep the image references.`,
        },
        { status: 400 },
      );
    }
    if (!input.referenceVideoUrl && !referenceImages.length) {
      return NextResponse.json(
        { error: "Reference mode needs a reference video or at least one image" },
        { status: 400 },
      );
    }
    // Enforced here as well as in the UI, since the client can be bypassed.
    const budget = imageReferenceBudget(model);
    if (referenceImages.length > budget) {
      return NextResponse.json(
        { error: `At most ${budget} image references.` },
        { status: 400 },
      );
    }
  }

  const admin = createAdminClient();
  const provider = activeProvider();

  // --- burst guard ---------------------------------------------------------
  // Credits are the budget; this only stops a runaway loop from emptying a
  // funded account in seconds.
  const { data: profile } = await admin
    .from("profiles")
    .select("daily_quota")
    .eq("id", user.id)
    .maybeSingle();

  const quota = profile?.daily_quota ?? 20;
  const { data: usedToday } = await admin.rpc("generations_today", {
    p_user: user.id,
  });

  if ((usedToday ?? 0) >= quota) {
    return NextResponse.json(
      {
        error: `Daily generation limit reached (${quota}). Resets at midnight UTC.`,
        code: "quota_exceeded",
      },
      { status: 429 },
    );
  }

  // providerCents/chargedCents are computed above, ahead of the free-tier
  // check — nothing to redo here.

  // --- the daily trial budget ---------------------------------------------
  // This is the control that actually holds. Cookies, IP addresses and device
  // fingerprints all leak, and all of them wrongly block real people; a total
  // daily spend cannot be evaded by creating more identities, and it never
  // blocks anyone who is not already past the limit.
  if (isAnonymous && (await trialBudgetSpent(providerCents))) {
    return NextResponse.json(
      {
        error:
          "Free clips are all used up for today. Sign in to keep generating.",
        code: "trial_budget_spent",
      },
      { status: 429 },
    );
  }

  // --- refuse before taking money we cannot honour ------------------------
  // The fal balance is prepaid and topped up by hand, so it can reach zero
  // while customers still hold credit they paid for. Without this check they
  // are debited, the provider call fails, and they get a dead job and a refund
  // instead of an answer.
  //
  // Reads the cached figure written by the cron rather than calling fal on
  // every generation: this guards against "empty", not against being a few
  // cents out, and a network round-trip on the critical path is not worth it.
  //
  // A null balance means the provider has no balance API or the key is not
  // admin-scoped. That is not permission to block anyone — an unmeasured
  // balance must never become an outage, so it falls through.
  const balanceCents = await providerBalanceCentsFresh();
  if (balanceCents != null && balanceCents < providerCents) {
    return NextResponse.json(
      {
        error:
          "Generation is paused right now. Nothing has been charged — please try again shortly.",
        code: "provider_unavailable",
      },
      { status: 503 },
    );
  }

  // --- create the row first, so a provider failure is still visible -------
  const { data: gen, error: insertError } = await admin
    .from("generations")
    .insert({
      user_id: user.id,
      mode: input.mode,
      model_id: model.id,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt ?? null,
      aspect_ratio: input.aspectRatio,
      duration_seconds: input.durationSeconds,
      quality: input.quality,
      cfg_scale: input.cfgScale,
      with_audio: input.withAudio && model.supportsAudio,
      source_image_url: input.imageUrl ?? null,
      end_image_url: input.endImageUrl ?? null,
      reference_video_url: input.referenceVideoUrl ?? null,
      reference_image_urls: referenceImages,
      provider: provider.name,
      status: "queued",
      cost_cents: providerCents,
      charged_cents: chargedCents,
    })
    .select()
    .single();

  if (insertError || !gen) {
    return NextResponse.json(
      { error: insertError?.message ?? "Could not create job" },
      { status: 500 },
    );
  }

  // --- take payment before calling the provider ---------------------------
  // The row exists first so the charge has something to reference, and so a
  // refusal leaves no phantom job behind.
  const paid = await tryDebit(user.id, chargedCents, gen.id);

  if (!paid) {
    await admin.from("generations").delete().eq("id", gen.id);
    return NextResponse.json(
      {
        error: "Not enough credit for this generation. Top up to continue.",
        code: "insufficient_credit",
        requiredCents: chargedCents,
      },
      { status: 402 },
    );
  }

  // --- hand off to the provider -------------------------------------------
  try {
    const task = await provider.create({
      mode: input.mode,
      modelId: model.id,
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      aspectRatio: input.aspectRatio,
      durationSeconds: input.durationSeconds,
      quality: input.quality,
      cfgScale: input.cfgScale,
      withAudio: input.withAudio && model.supportsAudio,
      imageUrl: input.imageUrl,
      endImageUrl: input.endImageUrl,
      referenceVideoUrl: input.referenceVideoUrl,
      referenceVideoDurationSeconds,
      referenceImageUrls: referenceImages,
      callbackUrl: process.env.PROVIDER_CALLBACK_URL || undefined,
      externalTaskId: gen.id,
    });

    const { data: updated } = await admin
      .from("generations")
      .update({
        provider_task_id: task.taskId,
        status: task.status === "queued" ? "processing" : task.status,
      })
      .eq("id", gen.id)
      .select()
      .single();

    return NextResponse.json({ generation: updated ?? gen }, { status: 201 });
  } catch (e) {
    const message =
      e instanceof ProviderError ? e.message : "Provider request failed";
    console.error("[generate] provider error", e);

    // The provider does not bill for a failed submission, so neither do we.
    await refundGeneration(user.id, gen.id, chargedCents, message);

    await admin
      .from("generations")
      .update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", gen.id);

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
