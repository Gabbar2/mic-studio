"use client";

/**
 * Forces a real "Save As" for a cross-origin file instead of opening it.
 *
 * A plain `<a href={url} download>` only gets the save-as behavior the
 * `download` attribute promises when `url` is same-origin (or a blob:/data:
 * URL) — browsers silently ignore `download` on a cross-origin link for
 * security reasons, and every video/upscale URL here points at fal's CDN or
 * Supabase Storage, never at this app's own origin. The visible symptom was
 * exactly "clicking Download just opens the file in a new tab", sometimes
 * on a provider page with its own player and its own download control the
 * person then has to find and click a second time.
 *
 * Fetching the bytes here and handing the browser a blob: URL sidesteps
 * that: a blob URL's origin is this page's own, so `download` is honored.
 * Both fal's CDN and Supabase's public storage send permissive CORS on GET,
 * so the fetch itself succeeds without special handling.
 */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    // Fall back to the old behavior rather than silently doing nothing —
    // worse than a second click is a dead button.
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a short delay, not immediately — revoking before the browser
  // has actually started the save can cancel it in some browsers.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}
