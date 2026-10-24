import type { AspectRatio, GenerationMode, Quality } from "../models";

export type ProviderName = "kling" | "fal" | "mock";

export type ProviderStatus = "queued" | "processing" | "succeeded" | "failed";

export interface CreateVideoParams {
  mode: GenerationMode;
  /** Our model id, e.g. "kling-3.0". Each provider maps this to its own id. */
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  durationSeconds: number;
  quality: Quality;
  cfgScale: number;
  withAudio: boolean;
  /** Start frame. Required for image2video. Publicly fetchable by the provider. */
  imageUrl?: string;
  /** Optional end frame — the model interpolates motion toward it. */
  endImageUrl?: string;
  /** Style / appearance references, addressed in the prompt as @Image1.. */
  referenceImageUrls?: string[];
  /** A video whose motion and style the generation follows (@Element1). */
  referenceVideoUrl?: string;
  /**
   * The reference video's own duration in seconds, client-measured and
   * server-validated — only meaningful for a model billed "additive" (see
   * `ModelDef.referenceVideoBilling`). Not sent to fal itself; this is for
   * this app's own pricing only, since fal reads the real file.
   */
  referenceVideoDurationSeconds?: number;
  callbackUrl?: string;
  /** Our generations.id, echoed back by providers that support it. */
  externalTaskId?: string;
}

/**
 * The normalised shape every provider returns. Deliberately narrow — nothing
 * downstream should ever see a provider's native envelope, which is what keeps
 * adding a third provider a contained change.
 */
export interface ProviderTask {
  taskId: string;
  status: ProviderStatus;
  videoUrl?: string;
  durationSeconds?: number;
  error?: string;
}

export interface UpscaleParams {
  /** A finished clip, publicly fetchable by the provider. */
  videoUrl: string;
  /** Multiplier against the source, e.g. 2 for 1080p → 4K. */
  factor: number;
  callbackUrl?: string;
}

export interface ProviderBalance {
  balance: number;
  currency: string;
}

export interface VideoProvider {
  name: ProviderName;
  create(params: CreateVideoParams): Promise<ProviderTask>;
  /**
   * `modelId` is only used by adapters that run more than one model behind
   * the same provider (fal.ts, which needs it to pick the right queue
   * namespace to poll) — an adapter tied to one model, like kling.ts, is free
   * to ignore it.
   */
  get(
    taskId: string,
    mode: GenerationMode,
    quality: Quality,
    modelId: string,
  ): Promise<ProviderTask>;
  /**
   * Remaining account credit, when the provider exposes it. Returns null when
   * it doesn't, or when the key lacks permission — callers treat that as
   * "unknown", never as an error.
   */
  getBalance?(): Promise<ProviderBalance | null>;
  /**
   * Upscaling, where the provider offers it. Optional because it is a separate
   * model rather than part of the video API — Kuaishou's own platform has no
   * equivalent, so the official adapter leaves both undefined and callers
   * surface a clear "not supported on this provider" instead of guessing.
   */
  upscale?(params: UpscaleParams): Promise<ProviderTask>;
  getUpscale?(taskId: string): Promise<ProviderTask>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
