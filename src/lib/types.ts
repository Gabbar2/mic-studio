import type { AspectRatio, GenerationMode, Quality } from "./models";
import type { UpscaleTarget } from "./upscale";

export type GenerationStatus = "queued" | "processing" | "succeeded" | "failed";

export type UpscaleStatus = GenerationStatus;

export interface Generation {
  id: string;
  user_id: string;
  mode: GenerationMode;
  model_id: string;
  prompt: string;
  negative_prompt: string | null;
  aspect_ratio: AspectRatio;
  duration_seconds: number;
  quality: Quality;
  cfg_scale: number;
  with_audio: boolean;
  source_image_url: string | null;
  end_image_url: string | null;
  reference_video_url: string | null;
  reference_image_urls: string[];
  provider: string;
  provider_task_id: string | null;
  status: GenerationStatus;
  error_message: string | null;
  video_url: string | null;
  thumbnail_url: string | null;
  storage_path: string | null;
  duration_actual: number | null;
  cost_cents: number | null;
  /** What the customer paid, which is not what the provider charged us. */
  charged_cents: number | null;
  upscale_status: UpscaleStatus | null;
  upscale_task_id: string | null;
  upscale_url: string | null;
  upscale_target: UpscaleTarget | null;
  upscale_cost_cents: number | null;
  upscale_charged_cents: number | null;
  upscale_error: string | null;
  upscale_completed_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export const TERMINAL: GenerationStatus[] = ["succeeded", "failed"];
