"use client";

import { loadFfmpeg } from "./ffmpegLoader";

/**
 * Cuts [startSeconds, endSeconds) out of a video file and returns it as a
 * new, real MP4 — not a URL fragment, not a start/end metadata pair. fal's
 * reference-to-video endpoints take a single file with no trim parameters of
 * their own, so if the editor only ever sent the full source clip, Wan 3.0's
 * 15s/Kling's 10s reference-video cap would reject anything longer almost
 * immediately. This is what makes "the actual trimmed video reference must
 * be transferred" true rather than aspirational.
 *
 * Output seeking (`-ss` placed after `-i`) rather than input seeking, and a
 * real re-encode rather than `-c copy`: input seeking and stream-copy trims
 * both snap to the nearest keyframe, which can be a second or more off from
 * the handle the person actually dragged to. Re-encoding costs time — this
 * runs single-threaded in the browser — but it's the only way the trimmed
 * clip starts and ends exactly where it was asked to.
 */
export async function extractClip(
  source: Blob,
  startSeconds: number,
  endSeconds: number,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  if (endSeconds <= startSeconds) {
    throw new Error("Clip end must come after its start.");
  }

  const ffmpeg = await loadFfmpeg(onProgress);

  const inputName = `in-${Date.now()}.mp4`;
  const outputName = `out-${Date.now()}.mp4`;

  const inputBytes = new Uint8Array(await source.arrayBuffer());
  await ffmpeg.writeFile(inputName, inputBytes);

  try {
    await ffmpeg.exec([
      "-i",
      inputName,
      "-ss",
      startSeconds.toFixed(3),
      "-to",
      endSeconds.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputName,
    ]);

    const outputBytes = await ffmpeg.readFile(outputName);
    return new Blob([outputBytes.buffer as ArrayBuffer], { type: "video/mp4" });
  } finally {
    // Best-effort cleanup of ffmpeg's in-memory filesystem — a failed exec
    // shouldn't leak the input file for the rest of the session.
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}

/**
 * Splits [startSeconds, endSeconds) into consecutive chunks no longer than
 * `maxChunkSeconds`, used when the selected range exceeds the chosen model's
 * reference-video cap. Plain arithmetic, evenly sized rather than
 * max-then-remainder (a 22s selection at a 15s cap becomes two 11s clips, not
 * a 15s clip and a leftover 7s one) — closer in length to each other, and
 * neither one is suspiciously close to the model's own limit.
 */
export function planSegments(
  startSeconds: number,
  endSeconds: number,
  maxChunkSeconds: number,
): { start: number; end: number }[] {
  const total = endSeconds - startSeconds;
  if (total <= 0 || maxChunkSeconds <= 0) return [];
  if (total <= maxChunkSeconds) {
    return [{ start: startSeconds, end: endSeconds }];
  }

  const count = Math.ceil(total / maxChunkSeconds);
  const chunkLength = total / count;
  return Array.from({ length: count }, (_, i) => ({
    start: startSeconds + i * chunkLength,
    end:
      i === count - 1 ? endSeconds : startSeconds + (i + 1) * chunkLength,
  }));
}

/**
 * Turns detected scene-cut timestamps (from `sceneDetect.ts`) into final clip
 * boundaries. Three steps: split [startSeconds, endSeconds] at every cut;
 * drop boundaries that land implausibly close together (detection can fire
 * twice for one real cut, or once a frame or two early) by merging the
 * segment that would result into its neighbor rather than producing a
 * near-zero-length clip nobody wants; then, for any segment still longer
 * than the model's own duration cap, fall back to the existing even-split
 * logic (`planSegments`) so nothing sent onward exceeds what the model
 * actually accepts. With no detected cuts at all, this degrades to exactly
 * one segment covering the whole selection, cap-split the same way the
 * editor already behaved before scene detection existed.
 */
export function planScenesFromCuts(
  cutTimes: number[],
  startSeconds: number,
  endSeconds: number,
  capSeconds: number,
  minSegmentSeconds = 0.6,
): { start: number; end: number }[] {
  if (endSeconds <= startSeconds) return [];

  const candidates = [startSeconds, ...cutTimes, endSeconds].filter(
    (t) => t > startSeconds - 0.001 && t < endSeconds + 0.001,
  );
  candidates.sort((a, b) => a - b);

  const boundaries: number[] = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - boundaries[boundaries.length - 1] >= minSegmentSeconds) {
      boundaries.push(candidates[i]);
    }
  }
  // The true end point can itself get merged away above, if the last real
  // cut landed within `minSegmentSeconds` of it — always keep it as the
  // final boundary rather than silently losing the tail of the selection.
  if (boundaries[boundaries.length - 1] !== endSeconds) {
    if (boundaries.length > 1) {
      boundaries[boundaries.length - 1] = endSeconds;
    } else {
      boundaries.push(endSeconds);
    }
  }

  const segments: { start: number; end: number }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    if (capSeconds > 0 && segEnd - segStart > capSeconds) {
      segments.push(...planSegments(segStart, segEnd, capSeconds));
    } else {
      segments.push({ start: segStart, end: segEnd });
    }
  }
  return segments;
}
