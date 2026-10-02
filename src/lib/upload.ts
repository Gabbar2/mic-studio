"use client";

import { createClient } from "./supabase/browser";
import { CONSENT_VERSION } from "./consent";

export type MediaKind = "image" | "video";

export const ACCEPT: Record<MediaKind, string> = {
  image: "image/jpeg,image/png,image/webp,image/gif,image/avif",
  video: "video/mp4,video/quicktime",
};

/**
 * Creates a session on demand, registered by Studio.
 *
 * Uploads are signed by the server, and the server has no idea who an
 * un-signed-in visitor is — so the whole image-to-video mode used to fail
 * with a flat "Not signed in" for anyone on the trial. Since dropping an image
 * is as deliberate an act as pressing Generate, it is a perfectly good moment
 * to create the anonymous account.
 *
 * A module-level slot rather than a prop because the callers — MediaDrop,
 * ReferencePanel — sit three levels down and have no other reason to know
 * about auth. Null when no Studio is mounted, in which case the upload is
 * attempted as-is and fails the way it always did.
 */
let ensureSession: (() => Promise<boolean>) | null = null;

export function setSessionEnsurer(fn: (() => Promise<boolean>) | null) {
  ensureSession = fn;
}

/**
 * Uploads a file to Supabase Storage via a server-issued signed URL and
 * returns the public URL the provider will fetch.
 *
 * Two hops rather than one: ask our server for permission, then send the bytes
 * straight to storage. Routing the bytes through the server would cap uploads
 * at the serverless body limit (~4.5 MB).
 */
export async function uploadMedia(
  file: File,
  kind: MediaKind,
  /**
   * The user has ticked the consent box. Passed through to the server, which
   * refuses without it — this argument is how the UI states the fact, not how
   * the rule is enforced.
   */
  consent = false,
): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  // Cheap when a session already exists — the ensurer returns immediately.
  if (ensureSession) await ensureSession();

  const signRes = await fetch("/api/upload/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      ext,
      size: file.size,
      consent,
      consentVersion: CONSENT_VERSION,
    }),
  });

  const signed = await signRes.json();
  if (!signRes.ok) throw new Error(signed.error ?? "Upload was refused");

  const supabase = createClient();
  const { error } = await supabase.storage
    .from("uploads")
    .uploadToSignedUrl(signed.path, signed.token, file);

  if (error) throw new Error(error.message);

  return signed.publicUrl as string;
}
