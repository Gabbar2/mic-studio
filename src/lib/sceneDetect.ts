"use client";

import { loadFfmpeg } from "./ffmpegLoader";

/**
 * Finds hard-cut (shot-boundary) timestamps inside [startSeconds, endSeconds]
 * of `source`, using ffmpeg's own classical scene-change scoring rather than
 * a paid vision model — a well-understood frame-difference signal (ffmpeg's
 * `select='gt(scene,…)'` filter) that needs no API key or external service.
 * It catches hard cuts reliably; it won't be as precise as a real vision
 * model on gradual fades/dissolves, but that tradeoff is what lets this ship
 * today instead of waiting on a provider integration.
 *
 * Returns timestamps (seconds, on the ORIGINAL source's own timeline — same
 * convention `startSeconds`/`endSeconds` already use, not relative to the
 * trimmed window) of each detected cut inside the window, sorted ascending.
 * This only detects cuts; `planScenesFromCuts` (in videoClip.ts) turns them
 * into actual segment boundaries.
 */
export async function detectSceneCuts(
  source: Blob,
  startSeconds: number,
  endSeconds: number,
  threshold = 0.35,
  onProgress?: (ratio: number) => void,
): Promise<number[]> {
  const ffmpeg = await loadFfmpeg(onProgress);

  const inputName = `scene-in-${Date.now()}.mp4`;
  const inputBytes = new Uint8Array(await source.arrayBuffer());
  await ffmpeg.writeFile(inputName, inputBytes);

  // ffmpeg's own `showinfo` filter logs one stderr line per frame it's
  // asked to look at — here, only the frames `select` already decided
  // crossed the scene-change threshold — and each line includes
  // `pts_time:<seconds>`. Scraping that log is the only way ffmpeg.wasm
  // surfaces this; there's no structured return value for it. A dedicated
  // listener, added and removed just for this call, keeps it from
  // interfering with the general `[ffmpeg] …` console logger already
  // registered in ffmpegLoader.ts — `on`/`off` support multiple
  // independent listeners per event.
  const cutTimes: number[] = [];
  const onLog = (e: { message: string }) => {
    const match = /pts_time:([0-9.]+)/.exec(e.message);
    if (match) cutTimes.push(parseFloat(match[1]));
  };
  ffmpeg.on("log", onLog);

  try {
    await ffmpeg.exec([
      "-i", inputName,
      "-ss", startSeconds.toFixed(3),
      "-to", endSeconds.toFixed(3),
      // Output-side seeking (after -i), same as extractClip — pts_time in
      // the resulting log lines stays on the original video's absolute
      // timeline, directly comparable to startSeconds/endSeconds, rather
      // than being reset near zero the way input-side seeking (-ss before
      // -i) would leave it.
      "-an",
      "-vf", `select='gt(scene,${threshold})',showinfo`,
      "-f", "null",
      "-",
    ]);
  } finally {
    ffmpeg.off("log", onLog);
    await ffmpeg.deleteFile(inputName).catch(() => {});
  }

  return cutTimes
    .filter((t) => t > startSeconds + 0.1 && t < endSeconds - 0.1)
    .sort((a, b) => a - b);
}
