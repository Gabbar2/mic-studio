/**
 * fal.ai adapter.
 *
 * fal resells several models behind one generic queue API: POST to submit,
 * then poll a status endpoint, then fetch the result from a second endpoint.
 * Auth is a single static key — no JWT signing, no business account — shared
 * across every model this adapter knows how to run.
 *
 * Four models live here across two families, each with its own request shape
 * and queue namespace (see `appFor` and the per-model `create*` functions):
 *   - Kling 3.0 — the original integration. Docs:
 *     https://fal.ai/models/fal-ai/kling-video/v3/standard/text-to-video/api
 *   - Wan 2.2 (A14B) — the budget model, frame-count based, no audio. Docs:
 *     https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/api
 *   - Wan 2.7 — newer, sharper, a plain `duration` field instead of frame
 *     counts. Docs: https://fal.ai/models/fal-ai/wan/v2.7/text-to-video/api
 *   - Wan 3.0 — Alibaba's newest, with a built-in audio toggle and its own
 *     top-level namespace (not under fal-ai/wan). Docs:
 *     https://fal.ai/models/alibaba/wan-3.0/text-to-video/api
 *
 * Wan 2.7 and Wan 3.0 both run reference-to-video (`.../reference-to-video`).
 * Wan 2.7 stays images-only — see `rejectReferenceVideo` and the ModelDef
 * doc comments in lib/models.ts for why. Wan 3.0's endpoint is the richer
 * "omni-reference" shape and also takes a reference *video*
 * (`reference_video_urls`), forwarded in `createWan30` below and billed
 * additively (output duration + the video's own duration) — see
 * `ModelDef.referenceVideoBilling` in lib/models.ts.
 */

import { ProviderError } from "./types";
import type {
  CreateVideoParams,
  ProviderBalance,
  ProviderStatus,
  ProviderTask,
  UpscaleParams,
  VideoProvider,
} from "./types";
import type { GenerationMode, Quality } from "../models";

const QUEUE = "https://queue.fal.run";

/** Account/billing lives on the REST host, not the queue host. */
const REST = "https://api.fal.ai";

/**
 * fal namespaces queue bookkeeping under the first two path segments, so a
 * request against .../v3/standard/text-to-video is polled at
 * fal-ai/kling-video/requests/<id>, and one against .../v2.2-a14b/text-to-video
 * is polled at fal-ai/wan/requests/<id>. The full-path form is tried as a
 * fallback because fal has changed this behaviour before.
 *
 * Wan 3.0 is the odd one out: it isn't under fal-ai/wan at all — fal lists it
 * under Alibaba's own namespace — so it gets a queue app of its own rather
 * than sharing WAN_APP with 2.2 and 2.7.
 */
const KLING_APP = "fal-ai/kling-video";
const WAN_APP = "fal-ai/wan";
const WAN3_APP = "alibaba/wan-3.0";

/** Which queue namespace a generation's requests live under, by model. */
function appFor(modelId: string): string {
  switch (modelId) {
    case "wan-2.2":
    case "wan-2.7":
      return WAN_APP;
    case "wan-3.0":
      return WAN3_APP;
    default:
      return KLING_APP;
  }
}

/**
 * Topaz upscaling is a separate fal app, so it has its own queue namespace —
 * an upscale request id is NOT resolvable under the kling-video namespace.
 */
const TOPAZ_APP = "fal-ai/topaz";
const TOPAZ_ENDPOINT = `${TOPAZ_APP}/upscale/video`;

function endpointFor(
  mode: GenerationMode,
  quality: Quality,
  hasReferenceVideo: boolean,
): string {
  const tier =
    quality === "4k" ? "4k" : quality === "pro" ? "pro" : "standard";

  if (mode === "reference2video") {
    // Two different models sit behind "reference mode". A reference video is a
    // top-level field on the O1 video-to-video endpoint — it is NOT an entry in
    // O3's `elements` array, which only accepts image sets. Sending a video
    // there is a 422.
    // Neither reference endpoint has a 4K variant.
    const refTier = tier === "4k" ? "pro" : tier;
    return hasReferenceVideo
      ? `${KLING_APP}/o1/video-to-video/reference`
      : `${KLING_APP}/o3/${refTier}/reference-to-video`;
  }

  const task = mode === "image2video" ? "image-to-video" : "text-to-video";
  return `${KLING_APP}/v3/${tier}/${task}`;
}

/** Wan 2.2's std/pro tiers map onto its 480p/720p resolution options. */
const WAN22_RESOLUTION: Record<"std" | "pro", "480p" | "720p"> = {
  std: "480p",
  pro: "720p",
};

/**
 * Wan 2.2 bills "video seconds" at a fixed 16fps — this is the unit its own
 * pricing page quotes, so it's also the rate this adapter submits at, rather
 * than letting `frames_per_second` drift from what was priced.
 */
const WAN22_FPS = 16;

function wan22EndpointFor(mode: GenerationMode): string {
  const task = mode === "image2video" ? "image-to-video" : "text-to-video";
  return `${WAN_APP}/v2.2-a14b/${task}`;
}

/**
 * Wan 2.2's request shape has almost nothing in common with Kling's —
 * different field names, a resolution enum instead of a quality string,
 * frame counts instead of a duration string, no audio option at all. Kept as
 * its own function rather than threaded through the Kling branch above,
 * which stays untouched this way.
 */
async function createWan22(p: CreateVideoParams): Promise<ProviderTask> {
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    resolution: WAN22_RESOLUTION[p.quality === "4k" ? "pro" : p.quality],
    num_frames: Math.round(p.durationSeconds * WAN22_FPS),
    frames_per_second: WAN22_FPS,
  };
  if (p.negativePrompt) body.negative_prompt = p.negativePrompt;
  // cfgScale is NOT forwarded as Wan's `guidance_scale` — our slider is a 0–1
  // range calibrated to Kling's cfg_scale, and Wan's guidance_scale is an
  // unrelated 1–20-ish scale with its own default (3.5). Sending our value
  // straight through would silently under-guide every Wan job; omitting it
  // and letting Wan use its own default is the safe choice. Same reasoning
  // applies to createWan27/createWan30 below.

  if (p.mode === "image2video") {
    if (!p.imageUrl) {
      throw new ProviderError("image2video requires an image URL", "fal");
    }
    body.image_url = p.imageUrl;
    // Aspect ratio is inferred from the start frame (Wan's own "auto"
    // default) — same behaviour as the Kling branch, so it's simply omitted.
  } else {
    body.aspect_ratio = p.aspectRatio;
  }

  let path = wan22EndpointFor(p.mode);
  if (p.callbackUrl) {
    path += `?fal_webhook=${encodeURIComponent(p.callbackUrl)}`;
  }

  const { ok, status, json } = await falFetch<FalSubmit & FalStatus>(path, {
    method: "POST",
    body,
  });

  if (!ok || !json.request_id) {
    throw new ProviderError(errorText(json), "fal", status);
  }

  return {
    taskId: json.request_id,
    status: mapStatus(json.status ?? "IN_QUEUE"),
  };
}

/** Wan 2.7's std/pro tiers map onto its 720p/1080p resolution options. */
const WAN27_RESOLUTION: Record<"std" | "pro", "720p" | "1080p"> = {
  std: "720p",
  pro: "1080p",
};

function wan27EndpointFor(mode: GenerationMode): string {
  const task =
    mode === "image2video"
      ? "image-to-video"
      : mode === "reference2video"
        ? "reference-to-video"
        : "text-to-video";
  return `${WAN_APP}/v2.7/${task}`;
}

/**
 * Rejects a reference-video upload for a Wan reference-to-video call that
 * doesn't support one — Wan 2.7 only, now that Wan 3.0 forwards its own (see
 * `createWan30` below). The UI never offers the video dropzone for Wan 2.7
 * (see `ModelDef.supportsReferenceVideo` in lib/models.ts — it's unset for
 * it), so this should be unreachable; it exists as a backstop in case stale
 * client state ever sends one anyway, rather than silently billing a request
 * this app can't price (fal combines input + output duration for a video
 * reference there too, per its own doc comment in lib/models.ts, and that
 * combination has not been verified against fal's actual billing for Wan 2.7
 * the way it has been for Wan 3.0).
 */
function rejectReferenceVideo(p: CreateVideoParams, model: string): void {
  if (p.referenceVideoUrl) {
    throw new ProviderError(
      `${model} doesn't support a video reference here — use Kling for that, or remove the video and keep the image references.`,
      "fal",
    );
  }
  if (!p.referenceImageUrls?.length) {
    throw new ProviderError(
      "Reference mode needs at least one reference image.",
      "fal",
    );
  }
}

/**
 * Wan 2.7 takes a plain `duration` in seconds (2–15 on text/image, 2–10 on
 * reference — see `maxReferenceDurationSeconds` in lib/models.ts) rather than
 * Wan 2.2's frame count — closer to Kling's shape, but its only audio input
 * is an attached `audio_url` (a voice/lip-sync track), not a generate-audio
 * toggle, so — same as 2.2 — nothing here maps to `withAudio` and it is
 * never sent.
 */
async function createWan27(p: CreateVideoParams): Promise<ProviderTask> {
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    resolution: WAN27_RESOLUTION[p.quality === "4k" ? "pro" : p.quality],
    duration: String(p.durationSeconds),
  };
  if (p.negativePrompt) body.negative_prompt = p.negativePrompt;

  if (p.mode === "image2video") {
    if (!p.imageUrl) {
      throw new ProviderError("image2video requires an image URL", "fal");
    }
    body.image_url = p.imageUrl;
  } else if (p.mode === "reference2video") {
    rejectReferenceVideo(p, "Wan 2.7");
    body.reference_image_urls = p.referenceImageUrls;
    body.aspect_ratio = p.aspectRatio;
  } else {
    body.aspect_ratio = p.aspectRatio;
  }

  let path = wan27EndpointFor(p.mode);
  if (p.callbackUrl) {
    path += `?fal_webhook=${encodeURIComponent(p.callbackUrl)}`;
  }

  const { ok, status, json } = await falFetch<FalSubmit & FalStatus>(path, {
    method: "POST",
    body,
  });

  if (!ok || !json.request_id) {
    throw new ProviderError(errorText(json), "fal", status);
  }

  return {
    taskId: json.request_id,
    status: mapStatus(json.status ?? "IN_QUEUE"),
  };
}

/** Wan 3.0's std/pro tiers map onto its 480p/720p resolution options — its
 * 1080p tier is deliberately unused, same reasoning as skipping Wan 2.2's
 * 580p: one less button, and this keeps Wan 3.0 priced as an alternative to
 * Kling rather than past it. */
const WAN30_RESOLUTION: Record<"std" | "pro", "480p" | "720p"> = {
  std: "480p",
  pro: "720p",
};

function wan30EndpointFor(mode: GenerationMode): string {
  const task =
    mode === "image2video"
      ? "image-to-video"
      : mode === "reference2video"
        ? "reference-to-video"
        : "text-to-video";
  return `${WAN3_APP}/${task}`;
}

/**
 * Wan 3.0 is the one Wan model with a real generate-audio toggle (`audio`,
 * boolean, no surcharge) — so unlike 2.2 and 2.7, `withAudio` is actually
 * forwarded here, including in reference mode (its reference endpoint takes
 * the same `audio` flag). It also doesn't accept `negative_prompt` at all
 * (not in its schema), so that field is never sent.
 *
 * Reference mode here is fal's "omni-reference" shape: `reference_image_urls`
 * for images (field name confirmed working in production already) and
 * `reference_video_urls` for a reference video, both arrays, sent alongside
 * each other when both are present. Only one video is ever attached in this
 * app (the composer offers a single video dropzone), so it's always a
 * one-element array when sent at all. Unlike Wan 2.7, no `rejectReferenceVideo`
 * call here — a reference video is expected and priced for (see
 * `estimateCostCents` in lib/models.ts), not a defensive-backstop case.
 */
async function createWan30(p: CreateVideoParams): Promise<ProviderTask> {
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    resolution: WAN30_RESOLUTION[p.quality === "4k" ? "pro" : p.quality],
    duration: p.durationSeconds,
    audio: p.withAudio,
  };

  if (p.mode === "image2video") {
    if (!p.imageUrl) {
      throw new ProviderError("image2video requires an image URL", "fal");
    }
    body.image_url = p.imageUrl;
  } else if (p.mode === "reference2video") {
    if (!p.referenceImageUrls?.length && !p.referenceVideoUrl) {
      throw new ProviderError(
        "Reference mode needs at least one reference image or a reference video.",
        "fal",
      );
    }
    if (p.referenceImageUrls?.length) {
      body.reference_image_urls = p.referenceImageUrls;
    }
    if (p.referenceVideoUrl) {
      body.reference_video_urls = [p.referenceVideoUrl];
    }
    body.aspect_ratio = p.aspectRatio;
  } else {
    body.aspect_ratio = p.aspectRatio;
  }

  let path = wan30EndpointFor(p.mode);
  if (p.callbackUrl) {
    path += `?fal_webhook=${encodeURIComponent(p.callbackUrl)}`;
  }

  const { ok, status, json } = await falFetch<FalSubmit & FalStatus>(path, {
    method: "POST",
    body,
  });

  if (!ok || !json.request_id) {
    throw new ProviderError(errorText(json), "fal", status);
  }

  return {
    taskId: json.request_id,
    status: mapStatus(json.status ?? "IN_QUEUE"),
  };
}

/**
 * Object/background segmentation (Reference Editor's select-to-keep step)
 * via fal's SAM 3 — a different fal app than anything above (`fal-ai/sam-3`,
 * not a video model), reusing the same queue submit/poll/fetch plumbing and
 * the same `FAL_KEY`. Docs: https://fal.ai/models/fal-ai/sam-3/image/api
 *
 * Submitting and polling use different path forms, confirmed from fal's own
 * docs rather than assumed from the video endpoints' pattern above: the
 * submit call needs the full model path (`fal-ai/sam-3/image`), but the
 * status/result polling calls need just the owner+app (`fal-ai/sam-3`) —
 * including `/image` in those returns a 405. Easy to get backwards, since
 * every other model in this file polls under its own submit path's prefix.
 *
 * SAM 3 is Meta's *promptable concept* segmentation, not classic
 * click-anywhere SAM — it finds whatever a short text phrase describes
 * ("the red jacket", "the background wall"), not whatever sits under a
 * pixel coordinate. The first version of this integration sent only a
 * point and no text, which silently fell back to fal's own documented
 * default concept ("wheel") and came back empty on every image that didn't
 * contain one — a model-shape mismatch, not a coordinate bug. `point_prompts`
 * do exist in the schema, but only to disambiguate *among* a text match's
 * detections, not to replace one, so this takes a text description, not a
 * click point.
 */
const SAM_SUBMIT_PATH = "fal-ai/sam-3/image";
const SAM_APP = "fal-ai/sam-3";

/**
 * Direct (non-queue) fal host. Most of this file's models are billed/slow
 * enough that fal only exposes them through the queue (submit → poll →
 * fetch) — SAM 3 included. Florence-2's object-detection task is small and
 * fast enough that fal exposes it as a plain synchronous POST on this host
 * instead, per its own docs' curl example; same `Authorization: Key …`
 * header as everything else here, just a different base URL and no
 * request_id/polling dance.
 */
const DIRECT = "https://fal.run";

interface SamResult {
  masks?: { url: string; width?: number; height?: number }[];
  scores?: number[];
}

interface Florence2DetectionResult {
  results?: { bboxes?: Array<{ label?: unknown }> };
}

/**
 * Lists candidate object/background labels found in `imageUrl`, via
 * Florence-2's object-detection task — the auto-detect pills shown above the
 * frame in the Reference Editor's select-objects step, so a person isn't
 * stuck typing every description by hand.
 *
 * Only the `label` string off each returned box is used. Florence-2 also
 * returns a bounding box per label, but this app re-segments with SAM 3 by
 * name when a pill is clicked (same call `segmentByPrompt` makes for a typed
 * description) rather than trusting Florence-2's own box as the mask, so
 * those coordinates — whose exact field shape fal's docs don't fully
 * spell out — are never read here at all; only `label`, which the docs do
 * confirm.
 *
 * Best-effort: the caller treats a thrown error here as "no auto-suggestions
 * available" and falls back to manual typing, never as blocking the rest of
 * the selector.
 */
export async function detectCandidateLabels(imageUrl: string): Promise<string[]> {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new ProviderError(
      "FAL_KEY is not set. Create one at https://fal.ai/dashboard/keys.",
      "fal",
    );
  }

  const res = await fetch(`${DIRECT}/fal-ai/florence-2-large/object-detection`, {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_url: imageUrl }),
    cache: "no-store",
  });

  const text = await res.text();
  let json: Florence2DetectionResult;
  try {
    json = JSON.parse(text) as Florence2DetectionResult;
  } catch {
    throw new ProviderError(
      `fal returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
      "fal",
      res.status,
    );
  }

  if (!res.ok) {
    throw new ProviderError(
      errorText(json as { error?: string; detail?: unknown; message?: string }),
      "fal",
      res.status,
    );
  }

  const seen = new Set<string>();
  const labels: string[] = [];
  for (const box of json.results?.bboxes ?? []) {
    const label = typeof box.label === "string" ? box.label.trim() : "";
    if (!label) continue;
    const key2 = label.toLowerCase();
    if (seen.has(key2)) continue;
    seen.add(key2);
    labels.push(label);
    if (labels.length >= 12) break;
  }
  return labels;
}

export interface SegmentResult {
  maskUrl: string;
  score: number;
}

/**
 * Asks SAM 3 for the mask of whatever `prompt` describes in `imageUrl` —
 * e.g. "the red jacket", "the dog", "the background wall". `imageUrl` has
 * to already be a URL fal's own servers can fetch — a blob: or data: URL
 * from the browser doesn't work here, which is why the caller uploads the
 * captured frame to Supabase Storage first and passes that public URL in.
 */
export async function segmentByPrompt(
  imageUrl: string,
  prompt: string,
): Promise<SegmentResult> {
  const submit = await falFetch<FalSubmit & FalStatus>(SAM_SUBMIT_PATH, {
    method: "POST",
    body: {
      image_url: imageUrl,
      prompt,
      return_multiple_masks: false,
      include_scores: true,
      output_format: "png",
    },
  });

  if (!submit.ok || !submit.json.request_id) {
    throw new ProviderError(errorText(submit.json), "fal", submit.status);
  }
  const requestId = submit.json.request_id;

  // Short synchronous poll rather than fal's webhook flow — this call is
  // made from an interactive click in the editor and the person is waiting
  // on screen for the mask to appear, not for a job that finishes minutes
  // later the way a video generation does. SAM 3's single-point-prompt
  // calls are normally quick; budgeted to stay comfortably under a
  // serverless function's own timeout either way.
  const POLL_INTERVAL_MS = 600;
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const statusRes = await falFetch<FalStatus>(
      `${SAM_APP}/requests/${requestId}/status`,
      { method: "GET" },
    );
    if (!statusRes.ok) {
      throw new ProviderError(errorText(statusRes.json), "fal", statusRes.status);
    }
    const mapped = mapStatus(statusRes.json.status);
    if (mapped === "failed") {
      throw new ProviderError(errorText(statusRes.json), "fal");
    }
    if (mapped === "succeeded") break;
    if (attempt === MAX_ATTEMPTS - 1) {
      throw new ProviderError("Segmentation timed out — try again.", "fal");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const resultRes = await falFetch<SamResult>(
    `${SAM_APP}/requests/${requestId}`,
    { method: "GET" },
  );
  if (!resultRes.ok) {
    throw new ProviderError(
      errorText(resultRes.json as { error?: string; detail?: unknown }),
      "fal",
      resultRes.status,
    );
  }
  const mask = resultRes.json.masks?.[0];
  if (!mask?.url) {
    // A clean 200 with an empty masks array is SAM 3 saying "nothing in
    // this image matches that description" — not a request error, so it
    // gets its own message rather than errorText's generic fallback (which
    // would otherwise just dump the empty {masks:[],scores:[],...} body).
    throw new ProviderError(
      "Nothing found matching that description — try a different phrase.",
      "fal",
    );
  }

  return { maskUrl: mask.url, score: resultRes.json.scores?.[0] ?? 0 };
}

interface FalSubmit {
  request_id: string;
  status?: string;
}

interface FalStatus {
  status?: string;
  error?: string;
  detail?: unknown;
}

interface FalResult {
  video?: { url?: string };
  error?: string;
  detail?: unknown;
}

async function falFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<{ ok: boolean; status: number; json: T }> {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new ProviderError(
      "FAL_KEY is not set. Create one at https://fal.ai/dashboard/keys.",
      "fal",
    );
  }

  const res = await fetch(`${QUEUE}/${path}`, {
    method: init.method,
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new ProviderError(
      `fal returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
      "fal",
      res.status,
    );
  }

  return { ok: res.ok, status: res.status, json };
}

function mapStatus(s: string | undefined): ProviderStatus {
  switch (s) {
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "processing";
    case "COMPLETED":
    case "OK":
      return "succeeded";
    case "FAILED":
    case "ERROR":
      return "failed";
    default:
      return "processing";
  }
}

/**
 * Pulls something human-readable out of fal's several error shapes.
 *
 * A 422 arrives as a list of field-level complaints; surfacing the field path
 * alongside the message is the difference between "status code 422" and
 * "elements.0: unexpected field video_url".
 */
function errorText(json: {
  error?: string;
  detail?: unknown;
  message?: string;
}): string {
  if (Array.isArray(json.detail) && json.detail.length) {
    const parts = (json.detail as Array<Record<string, unknown>>)
      .slice(0, 3)
      .map((d) => {
        const loc = Array.isArray(d.loc)
          ? (d.loc as unknown[]).filter((s) => s !== "body").join(".")
          : "";
        const msg = typeof d.msg === "string" ? d.msg : JSON.stringify(d);
        return loc ? `${loc}: ${msg}` : msg;
      });
    if (parts.length) return parts.join(" · ");
  }
  if (typeof json.detail === "string" && json.detail) return json.detail;
  if (typeof json.error === "string" && json.error) return json.error;
  if (typeof json.message === "string" && json.message) return json.message;

  const raw = JSON.stringify(json);
  return raw && raw !== "{}"
    ? `Provider rejected the request: ${raw.slice(0, 240)}`
    : "Generation failed at the provider";
}

export const falProvider: VideoProvider = {
  name: "fal",

  async create(p: CreateVideoParams): Promise<ProviderTask> {
    if (p.modelId === "wan-2.2") return createWan22(p);
    if (p.modelId === "wan-2.7") return createWan27(p);
    if (p.modelId === "wan-3.0") return createWan30(p);

    const body: Record<string, unknown> = {
      prompt: p.prompt,
      duration: String(p.durationSeconds),
      generate_audio: p.withAudio,
    };

    if (p.mode === "reference2video") {
      // Neither reference endpoint accepts cfg_scale or negative_prompt —
      // sending them is a validation error, not a no-op.
      body.aspect_ratio = p.aspectRatio;

      if (!p.referenceImageUrls?.length && !p.referenceVideoUrl) {
        throw new ProviderError(
          "Reference mode needs at least one reference image or a reference video.",
          "fal",
        );
      }

      if (p.referenceVideoUrl) {
        // O1 video-to-video. `keep_audio` preserves the source clip's audio;
        // there is no generative-audio option and no quality tier here.
        body.video_url = p.referenceVideoUrl;
        body.image_urls = p.referenceImageUrls ?? [];
        body.elements = [];
        body.keep_audio = p.withAudio;
        delete body.generate_audio;
      } else {
        // O3 reference-to-video.
        body.shot_type = "customize";
        body.image_urls = p.referenceImageUrls;
        if (p.imageUrl) body.start_image_url = p.imageUrl;
        if (p.endImageUrl) body.end_image_url = p.endImageUrl;
      }
    } else if (p.mode === "image2video") {
      body.cfg_scale = p.cfgScale;
      if (p.negativePrompt) body.negative_prompt = p.negativePrompt;
      if (!p.imageUrl) {
        throw new ProviderError("image2video requires an image URL", "fal");
      }
      // v3 names these start_/end_image_url — NOT the image_url used by
      // earlier Kling endpoints on fal.
      body.start_image_url = p.imageUrl;
      if (p.endImageUrl) body.end_image_url = p.endImageUrl;
      // aspect ratio is inferred from the start frame; sending it is rejected
    } else {
      body.cfg_scale = p.cfgScale;
      if (p.negativePrompt) body.negative_prompt = p.negativePrompt;
      body.aspect_ratio = p.aspectRatio;
    }

    let path = endpointFor(p.mode, p.quality, !!p.referenceVideoUrl);
    if (p.callbackUrl) {
      path += `?fal_webhook=${encodeURIComponent(p.callbackUrl)}`;
    }

    const { ok, status, json } = await falFetch<FalSubmit & FalStatus>(path, {
      method: "POST",
      body,
    });

    if (!ok || !json.request_id) {
      throw new ProviderError(errorText(json), "fal", status);
    }

    return { taskId: json.request_id, status: mapStatus(json.status ?? "IN_QUEUE") };
  },

  async get(
    taskId: string,
    _mode: GenerationMode,
    _quality: Quality,
    modelId: string,
  ): Promise<ProviderTask> {
    // Which queue namespace to poll depends on which model submitted this
    // job — Kling and Wan each live under their own fal app. `modelId` comes
    // from the generations row (see providerFor's callers), not from
    // whatever happens to be the *active* provider right now, so this still
    // resolves correctly for an older job even after PROVIDER or the default
    // model changes.
    const app = appFor(modelId);

    const statusRes = await falFetch<FalStatus>(
      `${app}/requests/${taskId}/status`,
      { method: "GET" },
    );

    if (!statusRes.ok) {
      // 404 here usually means the namespace guess was wrong rather than that
      // the job vanished — surface it rather than failing the row outright.
      throw new ProviderError(
        errorText(statusRes.json),
        "fal",
        statusRes.status,
      );
    }

    const mapped = mapStatus(statusRes.json.status);

    if (mapped === "failed") {
      return { taskId, status: "failed", error: errorText(statusRes.json) };
    }
    if (mapped !== "succeeded") {
      return { taskId, status: mapped };
    }

    const resultRes = await falFetch<FalResult>(`${app}/requests/${taskId}`, {
      method: "GET",
    });

    const url = resultRes.json.video?.url;
    if (!resultRes.ok || !url) {
      return { taskId, status: "failed", error: errorText(resultRes.json) };
    }

    return { taskId, status: "succeeded", videoUrl: url };
  },

  async upscale(p: UpscaleParams): Promise<ProviderTask> {
    let path = TOPAZ_ENDPOINT;
    if (p.callbackUrl) {
      path += `?fal_webhook=${encodeURIComponent(p.callbackUrl)}`;
    }

    const { ok, status, json } = await falFetch<FalSubmit & FalStatus>(path, {
      method: "POST",
      body: {
        video_url: p.videoUrl,
        upscale_factor: p.factor,
        // Topaz defaults to H265, which Chrome frequently cannot decode. An
        // upscaled master that will not play in the gallery is worse than no
        // upscale at all, so force H264.
        H264_output: true,
      },
    });

    if (!ok || !json.request_id) {
      throw new ProviderError(errorText(json), "fal", status);
    }

    return {
      taskId: json.request_id,
      status: mapStatus(json.status ?? "IN_QUEUE"),
    };
  },

  async getUpscale(taskId: string): Promise<ProviderTask> {
    const statusRes = await falFetch<FalStatus>(
      `${TOPAZ_APP}/requests/${taskId}/status`,
      { method: "GET" },
    );

    if (!statusRes.ok) {
      throw new ProviderError(
        errorText(statusRes.json),
        "fal",
        statusRes.status,
      );
    }

    const mapped = mapStatus(statusRes.json.status);

    if (mapped === "failed") {
      return { taskId, status: "failed", error: errorText(statusRes.json) };
    }
    if (mapped !== "succeeded") {
      return { taskId, status: mapped };
    }

    const resultRes = await falFetch<FalResult>(
      `${TOPAZ_APP}/requests/${taskId}`,
      { method: "GET" },
    );

    const url = resultRes.json.video?.url;
    if (!resultRes.ok || !url) {
      return { taskId, status: "failed", error: errorText(resultRes.json) };
    }

    return { taskId, status: "succeeded", videoUrl: url };
  },

  async getBalance(): Promise<ProviderBalance | null> {
    // fal issues keys at two scopes. API scope runs models; billing is
    // sensitive and needs Admin scope, so a normal generation key reads the
    // balance as 401 and this returns null.
    //
    // Rather than promote FAL_KEY to Admin — it is sent on every generation,
    // so its blast radius should stay small — the balance read prefers a
    // separate FAL_ADMIN_KEY and falls back to FAL_KEY for anyone whose key
    // already carries both scopes.
    const usingAdminKey = !!process.env.FAL_ADMIN_KEY;
    const key = process.env.FAL_ADMIN_KEY ?? process.env.FAL_KEY;
    if (!key) {
      console.error("[fal] getBalance: neither FAL_ADMIN_KEY nor FAL_KEY is set");
      return null;
    }

    // Every failure path below logs — this used to return null silently on
    // anything short of a thrown exception, which is exactly how a
    // misconfigured key (wrong value, wrong scope, wrong account) went
    // unnoticed for as long as it did: nothing short of opening the admin
    // panel and noticing a suspiciously small number would ever surface it.
    // None of these log the key itself, only which env var supplied it and
    // its first few characters — enough to confirm "is this even shaped
    // like a fal key" without putting the working secret in Vercel's logs.
    const keyPreview = `${key.slice(0, 7)}…(${key.length} chars)`;
    try {
      const res = await fetch(`${REST}/v1/account/billing?expand=credits`, {
        headers: { Authorization: `Key ${key}` },
        cache: "no-store",
      });

      if (!res.ok) {
        // 401/403 here almost always means the key isn't admin-scoped, or
        // isn't a fal key at all — report unknown (a permissions outcome,
        // not an outage) rather than breaking the header, but log exactly
        // what fal said so this is diagnosable from Vercel's logs alone.
        const body = await res.text().catch(() => "<unreadable body>");
        console.error(
          `[fal] getBalance: ${res.status} from fal using ${usingAdminKey ? "FAL_ADMIN_KEY" : "FAL_KEY"} (${keyPreview}) — ${body.slice(0, 500)}`,
        );
        return null;
      }

      const json = (await res.json()) as {
        credits?: { current_balance?: number; currency?: string };
      };

      const balance = json.credits?.current_balance;
      if (typeof balance !== "number") {
        console.error(
          `[fal] getBalance: 200 but no credits.current_balance in response — ${JSON.stringify(json).slice(0, 500)}`,
        );
        return null;
      }

      return { balance, currency: json.credits?.currency ?? "USD" };
    } catch (e) {
      console.error(
        `[fal] getBalance: request failed using ${usingAdminKey ? "FAL_ADMIN_KEY" : "FAL_KEY"} (${keyPreview})`,
        e,
      );
      return null;
    }
  },
};
