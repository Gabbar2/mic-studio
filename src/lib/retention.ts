import type { createAdminClient } from "./supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface StoredClip {
  id: string;
  url: string;
  storagePath: string;
  createdAt: string;
}

/**
 * Every clip this account currently has a durable copy of — `video_url` is
 * only set once generations.ts's mirrorToStorage has copied the provider's
 * (expiring) CDN link into this app's own public "generations" bucket, so a
 * null here means either the job never finished or the file was already
 * cleaned up. Either way there is nothing to email a link to.
 */
export async function listUserClips(
  admin: AdminClient,
  userId: string,
): Promise<StoredClip[]> {
  const { data } = await admin
    .from("generations")
    .select("id, video_url, storage_path, created_at")
    .eq("user_id", userId)
    .not("video_url", "is", null)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false });

  return (data ?? []).map((g) => ({
    id: g.id as string,
    url: g.video_url as string,
    storagePath: g.storage_path as string,
    createdAt: g.created_at as string,
  }));
}

/**
 * Removes every clip this account has stored — the storage object first
 * (so a crash between the two steps never leaves an orphaned file with no
 * database row pointing at it, only the safer opposite: a row that is about
 * to be deleted anyway), then the generation row itself.
 *
 * Deletes the whole row rather than just clearing video_url/storage_path,
 * same shape as 0013_retention.sql's purge_old_generations — one row here
 * means "this clip no longer exists anywhere," not "this clip exists but
 * its file is gone," which would be a confusing state for the gallery to
 * render around.
 *
 * Returns the count actually removed, for the admin UI and the exported
 * report — never throws; a storage failure for one file does not abort the
 * rest of the account's cleanup.
 */
export async function deleteUserClips(
  admin: AdminClient,
  userId: string,
): Promise<number> {
  const clips = await listUserClips(admin, userId);
  if (clips.length === 0) return 0;

  const paths = clips.map((c) => c.storagePath);
  const { error: storageError } = await admin.storage
    .from("generations")
    .remove(paths);
  if (storageError) {
    console.error("[retention] storage remove failed", userId, storageError);
    // Still proceed to drop the rows below — a file Storage refused to
    // remove (already gone, permissions hiccup) should not leave the
    // account's gallery pointing at dead links forever.
  }

  const { error: dbError, count } = await admin
    .from("generations")
    .delete({ count: "exact" })
    .in(
      "id",
      clips.map((c) => c.id),
    );
  if (dbError) {
    console.error("[retention] row delete failed", userId, dbError);
    return 0;
  }

  return count ?? clips.length;
}
