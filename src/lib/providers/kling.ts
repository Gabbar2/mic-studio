/**
 * Official Kuaishou / Kling Open Platform adapter.
 *
 * Auth: the platform does not take a static API key. You sign a short-lived
 * HS256 JWT with your Access Key / Secret Key pair and send it as a bearer
 * token. Tokens are cheap to mint, so we mint one per request rather than
 * caching — this avoids clock-skew and rotation headaches.
 *
 * Docs: https://app.klingai.com/global/dev/document-api
 */

import { SignJWT } from "jose";
import { ProviderError } from "./types";
import type {
  CreateVideoParams,
  ProviderStatus,
  ProviderTask,
  VideoProvider,
} from "./types";
import type { GenerationMode } from "../models";

const BASE_URL =
  process.env.KLING_BASE_URL ?? "https://api-singapore.klingai.com";

type KlingTaskStatus = "submitted" | "processing" | "succeed" | "failed";

interface KlingEnvelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T;
}

interface KlingTaskData {
  task_id: string;
  task_status: KlingTaskStatus;
  task_status_msg?: string;
  task_result?: {
    videos?: Array<{ id: string; url: string; duration: string }>;
  };
}

async function mintToken(): Promise<string> {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw new ProviderError(
      "KLING_ACCESS_KEY / KLING_SECRET_KEY are not set. Get them from the Kling console under API Management, or set PROVIDER=fal.",
      "kling",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(accessKey)
    .setExpirationTime(now + 1800) // 30 min
    .setNotBefore(now - 5) // tolerate small clock skew
    .sign(new TextEncoder().encode(secretKey));
}

async function call<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const token = await mintToken();

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  let json: KlingEnvelope<T>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(
      `Kling returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
      "kling",
      res.status,
    );
  }

  // Kling signals failure in the envelope even on HTTP 200.
  if (!res.ok || json.code !== 0) {
    throw new ProviderError(
      json.message || `Kling request failed (HTTP ${res.status})`,
      "kling",
      res.status,
    );
  }

  return json.data;
}

function mapStatus(s: KlingTaskStatus): ProviderStatus {
  switch (s) {
    case "submitted":
      return "queued";
    case "processing":
      return "processing";
    case "succeed":
      return "succeeded";
    case "failed":
      return "failed";
  }
}

function toTask(d: KlingTaskData): ProviderTask {
  const video = d.task_result?.videos?.[0];
  const status = mapStatus(d.task_status);

  return {
    taskId: d.task_id,
    status,
    videoUrl: video?.url,
    durationSeconds: video ? Number(video.duration) / 1000 || undefined : undefined,
    error: status === "failed" ? (d.task_status_msg ?? "Generation failed") : undefined,
  };
}

export const klingProvider: VideoProvider = {
  name: "kling",

  async create(p: CreateVideoParams): Promise<ProviderTask> {
    // This adapter only ever speaks to Kuaishou's own endpoint — it has no
    // idea how to run a non-Kling model. A model like Wan is fal.ai-exclusive
    // (there's no official direct API for it), so it only runs when
    // PROVIDER=fal is the active provider. Refusing clearly here beats
    // silently submitting someone's Wan job as a Kling one.
    if (p.modelId !== "kling-3.0") {
      throw new ProviderError(
        `The official Kling adapter can't run model "${p.modelId}" — set PROVIDER=fal to use it.`,
        "kling",
      );
    }

    const modelName = process.env.KLING_MODEL_NAME ?? "kling-v3-0";

    const common = {
      model_name: modelName,
      prompt: p.prompt,
      negative_prompt: p.negativePrompt || undefined,
      cfg_scale: p.cfgScale,
      mode: p.quality,
      duration: String(p.durationSeconds),
      ...(p.withAudio ? { audio: true } : {}),
      callback_url: p.callbackUrl,
      external_task_id: p.externalTaskId,
    };

    if (p.mode === "reference2video") {
      throw new ProviderError(
        "Reference mode isn't wired for the official Kling API yet — set PROVIDER=fal to use it.",
        "kling",
      );
    }

    if (p.mode === "image2video") {
      if (!p.imageUrl) {
        throw new ProviderError("image2video requires an image URL", "kling");
      }
      return toTask(
        await call<KlingTaskData>("/v1/videos/image2video", {
          method: "POST",
          body: {
            ...common,
            image: p.imageUrl,
            ...(p.endImageUrl ? { image_tail: p.endImageUrl } : {}),
          },
        }),
      );
    }

    return toTask(
      await call<KlingTaskData>("/v1/videos/text2video", {
        method: "POST",
        body: { ...common, aspect_ratio: p.aspectRatio },
      }),
    );
  },

  async get(taskId: string, mode: GenerationMode): Promise<ProviderTask> {
    const path = mode === "image2video" ? "image2video" : "text2video";
    return toTask(
      await call<KlingTaskData>(`/v1/videos/${path}/${taskId}`, {
        method: "GET",
      }),
    );
  },
};

/** Exported for the webhook route, which receives this shape unsolicited. */
export function klingPayloadToTask(d: KlingTaskData): ProviderTask {
  return toTask(d);
}
export type { KlingTaskData };
