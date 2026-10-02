/**
 * Mock provider — runs the whole pipeline with no credentials and no network.
 *
 * The submit time is baked into the task id, so get() can decide processing vs
 * succeeded without storing any state. Clips ship in public/mock/ rather than
 * coming from a sample-video CDN: third-party sample URLs rot (the well-known
 * Google bucket went private and every mock job started returning AccessDenied).
 *
 * The URL is absolute because the server fetches it back to mirror the result
 * into Supabase Storage, exercising the same code path production uses.
 */

import type { ProviderTask, VideoProvider } from "./types";

export const MOCK_PREFIX = "mock_";

const RENDER_MS = Number(process.env.MOCK_RENDER_SECONDS ?? 20) * 1000;
const BASE_URL = process.env.MOCK_BASE_URL ?? "http://localhost:3000";

const CLIPS = [
  "/mock/clip-1.mp4",
  "/mock/clip-2.mp4",
  "/mock/clip-3.mp4",
  "/mock/clip-4.mp4",
];

export const mockProvider: VideoProvider = {
  name: "mock",

  async create(): Promise<ProviderTask> {
    const taskId = `${MOCK_PREFIX}${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    return { taskId, status: "queued" };
  },

  async get(taskId: string): Promise<ProviderTask> {
    const startedAt = Number(taskId.split("_")[1]);
    const elapsed = Date.now() - (Number.isFinite(startedAt) ? startedAt : 0);

    if (elapsed < RENDER_MS) return { taskId, status: "processing" };

    // Deterministic pick, so re-polling the same job returns the same clip.
    let hash = 0;
    for (const ch of taskId) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    const clip = CLIPS[Math.abs(hash) % CLIPS.length];

    return {
      taskId,
      status: "succeeded",
      videoUrl: `${BASE_URL}${clip}`,
      durationSeconds: 6,
    };
  },
};
