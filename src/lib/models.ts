/**
 * Model registry.
 *
 * Four models (Kling 3.0, Wan 2.2, Wan 2.7, Wan 3.0), each declaring its own
 * modes, durations, qualities and prices — the UI, pricing page and admin
 * reports all iterate `MODELS` generically rather than special-casing one.
 * Which service actually runs a model is a separate axis — see lib/providers.
 *
 * Reference mode is the one place behavior forks per model rather than just
 * numbers: Kling serves it from a different endpoint family entirely (O3
 * reference-to-video, or O1 video-to-video when a reference *video* is
 * attached — a different parameter set again, one that rejects cfg_scale and
 * negative_prompt), while Wan's reference endpoints take images only here
 * (see the Wan model doc comments below for why).
 */

export type AspectRatio = "16:9" | "9:16" | "1:1";
export type Quality = "std" | "pro" | "4k";
export type GenerationMode = "text2video" | "image2video" | "reference2video";

export interface Rate {
  silent: number;
  withAudio: number;
}

export interface ModelDef {
  id: string;
  label: string;
  description: string;
  modes: GenerationMode[];
  durations: number[];
  aspectRatios: AspectRatio[];
  qualities: Quality[];
  supportsAudio: boolean;
  /**
   * USD cents per SECOND, by mode and quality tier, split by whether native
   * audio is on. Audio is a surcharge of 30–50% depending on the endpoint —
   * quoting the silent rate for an audio-on job understates the bill badly.
   */
  priceCentsPerSecond: Record<GenerationMode, Record<Quality, Rate>>;
  /**
   * A reference video routes to a different endpoint entirely (O1
   * video-to-video), which bills one flat per-second rate with no audio
   * surcharge and ignores the quality tier.
   */
  referenceVideoRate: Rate;
  maxPromptChars: number;
  /** Maximum reference images accepted in one request. */
  maxReferences: number;
  /**
   * Multiplies provider cost instead of the global PRICE_MARKUP env var, for
   * a model priced on its own curve rather than Kling's. Omit to use the
   * global markup, same as before this field existed.
   */
  priceMarkupOverride?: number;
  /**
   * What each quality tier actually renders at, when it isn't the global
   * "std/pro = 1080p, 4k = 4K" convention QUALITY_RESOLUTION assumes — e.g. a
   * budget model whose tiers are lower-resolution outright rather than a
   * resolution ceiling. Falls back to QUALITY_RESOLUTION per tier when unset.
   */
  qualityResolution?: Partial<Record<Quality, string>>;
  /**
   * Whether this model's reference-to-video endpoint accepts an uploaded
   * reference *video* (motion/frame-shape source), not just reference images.
   * Only Kling does here — its video-reference path (O1) also brings its own
   * UI (the video dropzone, start/end frame fields, flat per-second pricing
   * with no quality tier). A model's own reference-to-video endpoint can
   * exist without this: Wan's does, but accepts images only in this app (see
   * the Wan model doc comments for why video references aren't wired up for
   * it). Defaults to false — omit for any model that is images-only or has
   * no reference mode at all.
   */
  supportsReferenceVideo?: boolean;
  /**
   * Caps the durations offered in reference mode specifically, for a model
   * whose reference endpoint accepts a shorter range than its text/image
   * endpoints do. Falls back to `durations` when unset. Distinct from
   * `REFERENCE_VIDEO_MAX_DURATION_SECONDS` below, which is Kling's own cap
   * for the video-reference case specifically.
   */
  maxReferenceDurationSeconds?: number;
}

const V3: Record<Quality, Rate> = {
  std: { silent: 8.4, withAudio: 12.6 },
  pro: { silent: 11.2, withAudio: 16.8 },
  // Native 4K is a flat rate — audio carries no surcharge here.
  "4k": { silent: 42, withAudio: 42 },
};

const O3_REFERENCE: Record<Quality, Rate> = {
  std: { silent: 8.4, withAudio: 11.2 },
  pro: { silent: 11.2, withAudio: 14.0 },
  // No 4K reference endpoint exists; listed only to satisfy the record type.
  // qualitiesFor() keeps it unselectable in reference mode.
  "4k": { silent: 11.2, withAudio: 14.0 },
};

/**
 * O1 video-to-video (reference mode with a *reference video* attached) tops
 * out at 10s on fal's own schema — every other Kling 3.0 endpoint (including
 * O3 reference-to-video, used when reference mode has only images) goes up
 * to 15s. Keeping this separate from `ModelDef.durations` means the 15s
 * option can exist for everyone else without offering a duration this one
 * path will reject. See `durationsFor` below.
 */
export const REFERENCE_VIDEO_MAX_DURATION_SECONDS = 10;

export const KLING_V3: ModelDef = {
  id: "kling-3.0",
  label: "Kling 3.0",
  description:
    "Kuaishou's flagship. Photoreal motion, strong character consistency, native audio, up to 15s.",
  modes: ["text2video", "image2video", "reference2video"],
  durations: [5, 10, 15],
  aspectRatios: ["16:9", "9:16", "1:1"],
  qualities: ["std", "pro", "4k"],
  supportsAudio: true,
  priceCentsPerSecond: {
    text2video: V3,
    image2video: V3,
    reference2video: O3_REFERENCE,
  },
  referenceVideoRate: { silent: 16.8, withAudio: 16.8 },
  maxPromptChars: 2500,
  maxReferences: 4,
  supportsReferenceVideo: true,
};

/**
 * Wan 2.2 (A14B), run through fal.ai — https://fal.ai/models/fal-ai/wan/v2.2-a14b
 *
 * The budget option: fal bills this one $0.04/s at 480p and $0.08/s at 720p,
 * versus Kling's $0.084–$0.112/s at the same 1080p std/pro tiers — roughly
 * half the provider cost for std, with results that hold up fine for short
 * social-style clips even if they don't match Kling's fidelity at 1080p+.
 *
 * Only two tiers are exposed (std → 480p, pro → 720p) rather than Wan's full
 * three (it also offers 580p) — one less button, and 480p/720p already reads
 * clearly as "cheap" vs "sharper", the same shape as every other quality
 * toggle in this app.
 *
 * No audio: the text/image-to-video endpoints used here don't generate it
 * (Wan's audio variant is a separate speech-to-video model this app doesn't
 * use) — `supportsAudio: false` hides the toggle entirely, same as any model
 * that can't do it.
 *
 * No reference-to-video: Wan's fal endpoints don't offer it, so `modes` just
 * omits it — the reference2video entries below exist only because
 * `priceCentsPerSecond` and `referenceVideoRate` are typed to require them;
 * they're unreachable since nothing ever requests this mode for this model.
 *
 * Durations stop at 10s (not Kling's 15s): fal's own schema caps frames at
 * 161 and this bills "per video second" at a fixed 16fps, so 15s (240
 * frames) would simply be rejected by the provider.
 *
 * `priceMarkupOverride: 2.5` (vs. the global 1.8x) is deliberate, not a typo:
 * at 1.8x this model's low provider cost would make Mic Studio's own cut on
 * it tiny in absolute cents even though the percentage matched Kling. 2.5x
 * keeps every price here still well under Kling's equivalent tier (see the
 * doc comment above) while roughly doubling the margin, in cents, per clip.
 */
const WAN_RATES: Record<Quality, Rate> = {
  std: { silent: 4.0, withAudio: 4.0 },
  pro: { silent: 8.0, withAudio: 8.0 },
  // No 4K tier — filtered out via `qualities` below; listed only to satisfy
  // the Record<Quality, Rate> type.
  "4k": { silent: 8.0, withAudio: 8.0 },
};

export const WAN_2_2: ModelDef = {
  id: "wan-2.2",
  label: "Wan 2.2",
  description:
    "Fast and cheap. Solid short clips at 480p/720p, no native audio.",
  modes: ["text2video", "image2video"],
  durations: [5, 10],
  aspectRatios: ["16:9", "9:16", "1:1"],
  qualities: ["std", "pro"],
  supportsAudio: false,
  priceCentsPerSecond: {
    text2video: WAN_RATES,
    image2video: WAN_RATES,
    // Unreachable — see doc comment above.
    reference2video: WAN_RATES,
  },
  // Unreachable — Wan never runs in reference mode, so no job ever prices off
  // this field. Set to the pro rate only so the type is satisfied.
  referenceVideoRate: { silent: 8.0, withAudio: 8.0 },
  maxPromptChars: 2000,
  maxReferences: 0,
  priceMarkupOverride: 2.5,
  qualityResolution: { std: "480p", pro: "720p" },
};

/**
 * Wan 2.7, also run through fal.ai — https://fal.ai/models/fal-ai/wan/v2.7/text-to-video
 *
 * The middle Wan tier: $0.10/s at 720p and $0.15/s at 1080p, versus Kling's
 * $0.084/s (std, 1080p) and $0.112/s (pro, 1080p). At the resolutions this
 * app exposes, 2.7 is actually *pricier per second* than Kling's std/pro —
 * it sells on being a newer model with up to 1080p, native generated audio,
 * and clips up to 15s, not on being cheap. Positioned (see
 * `priceMarkupOverride` below) to land between Kling's Pro and native-4K
 * tiers rather than under Kling at all.
 *
 * No audio toggle: 2.7's only audio input on fal is `audio_url` (an attached
 * voice/lip-sync track), a different feature from "generate a soundtrack
 * with the picture" — there's nothing for this app's withAudio switch to
 * turn on, so `supportsAudio: false` hides it, same reasoning as Wan 2.2.
 *
 * Reference-to-video is supported, images only: fal's Wan 2.7 reference
 * endpoint (`v2.7/reference-to-video`) takes both `reference_image_urls` and
 * `reference_video_urls` in one request and bills "input and output duration
 * combined" when a reference video is attached — an open-ended cost this app
 * has no way to bound upfront, unlike the flat per-second rate Kling's O1
 * charges for the same idea. So only `reference_image_urls` is ever sent here
 * (`supportsReferenceVideo` is left unset/false) — the video dropzone simply
 * doesn't render for this model, and the provider throws if one ever arrives
 * anyway. Billed at this model's normal per-resolution rate, same as
 * text/image-to-video — unlike Kling, there's no separate flat reference
 * rate to fall back to, because the video-reference path that would need one
 * is exactly what's excluded.
 *
 * Reference mode caps at 10s, not this model's usual 15: fal's own schema for
 * the reference endpoint only enumerates durations 2–10, two seconds under
 * every other Wan 2.7 endpoint. See `maxReferenceDurationSeconds` below.
 *
 * Full 5/10/15s range elsewhere: unlike Wan 2.2 (frame-capped at 10s), 2.7
 * takes a plain `duration` in seconds up to 15 on its text/image endpoints —
 * no reason to hold back the longest length Kling itself offers there.
 */
const WAN_2_7_RATES: Record<Quality, Rate> = {
  std: { silent: 10.0, withAudio: 10.0 },
  pro: { silent: 15.0, withAudio: 15.0 },
  // No 4K tier — filtered out via `qualities` below; listed only to satisfy
  // the Record<Quality, Rate> type.
  "4k": { silent: 15.0, withAudio: 15.0 },
};

export const WAN_2_7: ModelDef = {
  id: "wan-2.7",
  label: "Wan 2.7",
  description:
    "Newer and sharper than Wan 2.2. Up to 1080p and 15s — priced between Kling Pro and 4K.",
  modes: ["text2video", "image2video", "reference2video"],
  durations: [5, 10, 15],
  aspectRatios: ["16:9", "9:16", "1:1"],
  qualities: ["std", "pro"],
  supportsAudio: false,
  priceCentsPerSecond: {
    text2video: WAN_2_7_RATES,
    image2video: WAN_2_7_RATES,
    reference2video: WAN_2_7_RATES,
  },
  // Unreachable — this model never runs the video-reference path that would
  // price off this field (see doc comment above); kept only to satisfy the
  // type.
  referenceVideoRate: { silent: 15.0, withAudio: 15.0 },
  maxPromptChars: 5000,
  // fal doesn't publish a hard cap on reference_image_urls for this endpoint
  // — 4 matches Kling's own budget and keeps the reference panel's layout
  // identical across models rather than guessing at a bigger number.
  maxReferences: 4,
  priceMarkupOverride: 2.0,
  qualityResolution: { std: "720p", pro: "1080p" },
  maxReferenceDurationSeconds: 10,
};

/**
 * Wan 3.0, also run through fal.ai — https://fal.ai/models/alibaba/wan-3.0/text-to-video
 * Lives under its own queue namespace, not fal-ai/wan — see fal.ts.
 *
 * Alibaba's newest Wan, with three real resolution tiers ($0.05/480p,
 * $0.10/720p, $0.20/1080p per second) and a genuine built-in audio toggle
 * (no surcharge) — the one Wan model here that can turn audio on or off like
 * Kling can. Only 480p/std and 720p/pro are exposed, the same two-tier
 * pattern as every other model in this app; 1080p is skipped because at
 * $0.20/s it costs nearly double Kling's own pro tier for the same
 * resolution ceiling, which would undercut nothing.
 *
 * At the tiers actually used, this is the one Wan model priced *below*
 * Kling at both tiers it offers (see `priceMarkupOverride` below) — std
 * undercuts Kling's std, and pro lands at the same credit price as Kling's
 * pro despite being the newest model with native audio.
 *
 * Reference-to-video is supported, images only — same reasoning as Wan 2.7:
 * fal's `alibaba/wan-3.0/reference-to-video` also takes `reference_video_urls`
 * alongside `reference_image_urls`, and this app has no verified, bounded way
 * to price a request that includes one, so only images are ever sent
 * (`supportsReferenceVideo` stays unset/false). fal documents up to 10
 * reference images for this endpoint — see `maxReferences` below. Billed at
 * this model's normal per-resolution rate, same as text/image-to-video; no
 * duration cap narrower than the rest of the model is documented, so the
 * usual 5/10/15s range carries over unchanged.
 */
const WAN_3_0_RATES: Record<Quality, Rate> = {
  std: { silent: 5.0, withAudio: 5.0 },
  pro: { silent: 10.0, withAudio: 10.0 },
  // No 4K tier — filtered out via `qualities` below; listed only to satisfy
  // the Record<Quality, Rate> type.
  "4k": { silent: 10.0, withAudio: 10.0 },
};

export const WAN_3_0: ModelDef = {
  id: "wan-3.0",
  label: "Wan 3.0",
  description:
    "Alibaba's newest. Native generated audio, cheaper than Kling at Standard, matches Kling's price at Pro.",
  modes: ["text2video", "image2video", "reference2video"],
  durations: [5, 10, 15],
  aspectRatios: ["16:9", "9:16", "1:1"],
  qualities: ["std", "pro"],
  supportsAudio: true,
  priceCentsPerSecond: {
    text2video: WAN_3_0_RATES,
    image2video: WAN_3_0_RATES,
    reference2video: WAN_3_0_RATES,
  },
  // Unreachable — this model never runs the video-reference path that would
  // price off this field (see doc comment above); kept only to satisfy the
  // type.
  referenceVideoRate: { silent: 10.0, withAudio: 10.0 },
  maxPromptChars: 2000,
  // fal documents "up to 10 reference image URLs" for this endpoint.
  maxReferences: 10,
  priceMarkupOverride: 2.0,
  qualityResolution: { std: "480p", pro: "720p" },
};

export const MODELS: ModelDef[] = [KLING_V3, WAN_2_2, WAN_2_7, WAN_3_0];

export const DEFAULT_MODEL_ID = KLING_V3.id;

/** `model.priceMarkupOverride` when set, else the operator's global markup. */
export function effectiveMarkup(model: ModelDef, globalMarkup: number): number {
  return model.priceMarkupOverride ?? globalMarkup;
}

export const QUALITY_LABEL: Record<Quality, string> = {
  std: "Standard",
  pro: "Pro",
  "4k": "4K",
};

/** 1080p for both non-4K tiers; the 4K endpoint is genuinely native 4K. */
export const QUALITY_RESOLUTION: Record<Quality, string> = {
  std: "1080p",
  pro: "1080p",
  "4k": "4K",
};

/** A model's own resolution label for a tier, falling back to the default. */
export function resolutionFor(model: ModelDef, quality: Quality): string {
  return model.qualityResolution?.[quality] ?? QUALITY_RESOLUTION[quality];
}

/**
 * Which tiers a given mode can actually use. Reference mode runs on the O3 and
 * O1 endpoints, neither of which has a 4K variant — offering the button there
 * would be a promise the provider can't keep.
 */
export function qualitiesFor(
  model: ModelDef,
  mode: GenerationMode,
): Quality[] {
  return mode === "reference2video"
    ? model.qualities.filter((q) => q !== "4k")
    : model.qualities;
}

/**
 * Which durations are actually offered, given the mode and — for reference
 * mode specifically — whether a reference *video* is attached. Same
 * reasoning as `qualitiesFor`: a duration the target endpoint will reject
 * should not be selectable in the first place, rather than offered and then
 * failing at the provider.
 *
 * Two different caps can apply in reference mode, and they stack with
 * `Math.min` rather than one overriding the other: Kling's video-reference
 * case uses the shared `REFERENCE_VIDEO_MAX_DURATION_SECONDS`, while a
 * model's own `maxReferenceDurationSeconds` (Wan 2.7's reference endpoint
 * tops out at 10s regardless of whether a video is attached, since this app
 * never attaches one for Wan at all) applies independently of that.
 */
export function durationsFor(
  model: ModelDef,
  mode: GenerationMode,
  hasReferenceVideo = false,
): number[] {
  if (mode !== "reference2video") return model.durations;

  const cap = Math.min(
    hasReferenceVideo ? REFERENCE_VIDEO_MAX_DURATION_SECONDS : Infinity,
    model.maxReferenceDurationSeconds ?? Infinity,
  );
  return Number.isFinite(cap)
    ? model.durations.filter((d) => d <= cap)
    : model.durations;
}

export const MODE_LABEL: Record<GenerationMode, string> = {
  text2video: "Text → Video",
  image2video: "Image → Video",
  reference2video: "Reference → Video",
};

export function getModel(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}

export function estimateCostCents(
  model: ModelDef,
  mode: GenerationMode,
  quality: Quality,
  durationSeconds: number,
  withAudio: boolean,
  hasReferenceVideo = false,
): number {
  const rate =
    mode === "reference2video" && hasReferenceVideo
      ? model.referenceVideoRate
      : model.priceCentsPerSecond[mode][quality];

  return Math.round(
    (withAudio ? rate.withAudio : rate.silent) * durationSeconds,
  );
}

/**
 * How many image references are allowed. The reference video is a top-level
 * field on the video endpoint rather than one of the reference slots, so it
 * does not reduce the image budget.
 */
export function imageReferenceBudget(model: ModelDef): number {
  return model.maxReferences;
}
