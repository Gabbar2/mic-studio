"use client";

/**
 * Captures a single frame from `src` at `atSeconds` as a small JPEG data URL
 * — used to give each auto-detected scene clip a preview tile. Resolves to
 * null rather than throwing on failure: a pasted URL without permissive CORS
 * headers taints the canvas on draw/toDataURL (the same caveat TrimTimeline's
 * own thumbnail strip already works around), and a missing preview image
 * isn't worth failing the whole prepare flow over — the tile just renders
 * without one.
 *
 * `maxWidth`/`maxHeight` bound a box the frame is fit *inside*, not a shape
 * it's stretched *to* — the canvas itself is sized from the source video's
 * own `videoWidth`/`videoHeight` (only known once `loadedmetadata` fires, so
 * callers can't precompute it up front). The original version drew straight
 * into a fixed 160×90 canvas regardless of the source's real aspect ratio,
 * which squashed every portrait (9:16) reference clip horizontally into a
 * 16:9 box — visibly warped text and faces in the resulting tile. Callers
 * that pass a non-square box (e.g. the old 160×90 default) still get a
 * correctly proportioned thumbnail; the box just bounds its longest side.
 */
export async function captureThumbnail(
  src: string,
  atSeconds: number,
  maxWidth = 160,
  maxHeight = 160,
): Promise<string | null> {
  const frames = await captureThumbnails(src, [atSeconds], maxWidth, maxHeight);
  return frames[0] ?? null;
}

/**
 * Same capture as `captureThumbnail` above, but for several timestamps off
 * one shared `<video>`/load — built for composeReferencePrompt's "a few
 * sample frames across the clip" need (see ReferenceEditor's
 * continueInStudio), where calling captureThumbnail in a loop would reload
 * and re-seek the whole video from scratch for every single frame. Returns
 * one entry per requested timestamp, in the same order, `null` for any
 * frame that failed — a partial result still gives the prompt-writer
 * something to look at rather than discarding every frame over one bad
 * seek.
 */
export async function captureThumbnails(
  src: string,
  atSecondsList: number[],
  maxWidth = 160,
  maxHeight = 160,
): Promise<(string | null)[]> {
  if (atSecondsList.length === 0) return [];

  try {
    const video = document.createElement("video");
    video.src = src;
    video.muted = true;
    video.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not load video"));
    });

    const sourceWidth = video.videoWidth || 16;
    const sourceHeight = video.videoHeight || 9;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return atSecondsList.map(() => null);

    const results: (string | null)[] = [];
    for (const atSeconds of atSecondsList) {
      try {
        await new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error("Could not seek video"));
          video.currentTime = Math.min(
            Math.max(0, atSeconds),
            Math.max(0, video.duration - 0.05),
          );
        });
        ctx.drawImage(video, 0, 0, width, height);
        results.push(canvas.toDataURL("image/jpeg", 0.65));
      } catch {
        results.push(null);
      }
    }
    return results;
  } catch {
    return atSecondsList.map(() => null);
  }
}
