import { createAdminClient } from "./supabase/admin";
import type { ProviderTask } from "./providers";
import { refundGeneration } from "./credits";

/**
 * Applies a provider task payload to our generations row. Shared by the
 * webhooks and the polling fallback so the two can never drift.
 *
 * Idempotent: safe to call repeatedly with the same payload, and it will not
 * walk a row backwards out of a terminal state (webhooks can arrive late and
 * out of order).
 */
export async function applyTaskUpdate(
  taskId: string,
  task: ProviderTask,
): Promise<void> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("generations")
    .select("id, status, user_id, charged_cents")
    .eq("provider_task_id", taskId)
    .maybeSingle();

  if (!row) return; // not ours, or already deleted
  if (row.status === "succeeded" || row.status === "failed") return;

  const patch: Record<string, unknown> = { status: task.status };

  if (task.status === "succeeded" && task.videoUrl) {
    patch.video_url = task.videoUrl;
    patch.duration_actual = task.durationSeconds ?? null;
    patch.completed_at = new Date().toISOString();
  }

  if (task.status === "failed") {
    patch.error_message = task.error ?? "Generation failed";
    patch.completed_at = new Date().toISOString();
  }

  await admin.from("generations").update(patch).eq("id", row.id);

  // A job can also fail after it was accepted — mid-render, or on a content
  // rejection. The provider bills neither, so the charge is reversed here too.
  if (task.status === "failed" && row.charged_cents) {
    await refundGeneration(
      row.user_id,
      row.id,
      row.charged_cents,
      task.error ?? "Generation failed",
    );
  }

  // Mirror the finished file into our own storage. Provider CDN links expire
  // (~30 days at time of writing for Kling; fal's are shorter), so a gallery
  // that only stores their URL silently rots. Fire and forget — a failure here
  // is not a failed job.
  if (task.status === "succeeded" && task.videoUrl) {
    void mirrorToStorage(row.id, task.videoUrl).catch((e) =>
      console.error("[mirror] failed", row.id, e),
    );
  }
}

async function mirrorToStorage(generationId: string, url: string) {
  const admin = createAdminClient();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch video ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const path = `${generationId}.mp4`;

  const { error } = await admin.storage
    .from("generations")
    .upload(path, bytes, { contentType: "video/mp4", upsert: true });
  if (error) throw error;

  const { data } = admin.storage.from("generations").getPublicUrl(path);

  await admin
    .from("generations")
    .update({ storage_path: path, video_url: data.publicUrl })
    .eq("id", generationId);
}
