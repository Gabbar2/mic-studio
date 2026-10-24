"use client";

/**
 * Captures a single frame from `src` at `atSeconds` as a small JPEG data URL
 * — used to give each auto-detected scene clip a preview tile. Resolves to
 * null rather than throwing on failure: a pasted URL without permissive CORS
 * headers taints the canvas on draw/toDataURL (the same caveat TrimTimeline's
 * own thumbnail strip already works around), and a missing preview image
 * isn't worth failing the whole prepare flow over — the tile just renders
 * without one.
 */
export async function captureThumbnail(
  src: string,
  atSeconds: number,
  width = 160,
  height = 90,
): Promise<string | null> {
  try {
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not load video"));
    });
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = Math.min(
        Math.max(0, atSeconds),
        Math.max(0, video.duration - 0.05),
      );
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.65);
  } catch {
    return null;
  }
}
