import { createAdminClient } from "./supabase/admin";
import type { ProviderTask } from "./providers";
import { refundGeneration } from "./credits";

/**
 * Applies an upscale task payload to its generations row.
 *
 * Kept separate from applyTaskUpdate() rather than folded into it: an upscale
 * shares a row with the clip but has its own lifecycle, and conflating the two
 * would let a finished upscale walk the clip's own status backwards.
 *
 * Idempotent, and refuses to move out of a terminal state.
 */
export async function applyUpscaleUpdate(
  taskId: string,
  task: ProviderTask,
): Promise<void> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("generations")
    .select("id, user_id, upscale_status, upscale_charged_cents")
    .eq("upscale_task_id", taskId)
    .maybeSingle();

  if (!row) return;
  if (row.upscale_status === "succeeded" || row.upscale_status === "failed") {
    return;
  }

  const patch: Record<string, unknown> = { upscale_status: task.status };

  if (task.status === "succeeded" && task.videoUrl) {
    patch.upscale_url = task.videoUrl;
    patch.upscale_completed_at = new Date().toISOString();
  }

  if (task.status === "failed") {
    patch.upscale_error = task.error ?? "Upscale failed";
    patch.upscale_completed_at = new Date().toISOString();
    // A failed upscale was never delivered, so it should not appear in spend.
    patch.upscale_cost_cents = null;
    patch.upscale_charged_cents = null;
  }

  await admin.from("generations").update(patch).eq("id", row.id);

  if (task.status === "failed" && row.upscale_charged_cents) {
    await refundGeneration(
      row.user_id,
      row.id,
      row.upscale_charged_cents,
      task.error ?? "Upscale failed",
    );
  }

  // Deliberately NOT mirrored into Supabase storage the way finished clips are.
  // A 4K master runs to ~120 MB, and the free tier holds 1 GB in total — eight
  // upscales would fill it. The provider link is live for a while; the UI
  // nudges you to download. Set MIRROR_UPSCALES=1 to keep copies anyway.
  if (
    task.status === "succeeded" &&
    task.videoUrl &&
    process.env.MIRROR_UPSCALES === "1"
  ) {
    void mirrorUpscale(row.id, task.videoUrl).catch((e) =>
      console.error("[mirror upscale] failed", row.id, e),
    );
  }
}

async function mirrorUpscale(generationId: string, url: string) {
  const admin = createAdminClient();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch upscale ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const path = `${generationId}-upscaled.mp4`;

  const { error } = await admin.storage
    .from("generations")
    .upload(path, bytes, { contentType: "video/mp4", upsert: true });
  if (error) throw error;

  const { data } = admin.storage.from("generations").getPublicUrl(path);

  await admin
    .from("generations")
    .update({ upscale_url: data.publicUrl })
    .eq("id", generationId);
}
