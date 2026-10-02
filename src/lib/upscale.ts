/**
 * Video upscaling via Topaz.
 *
 * The reference endpoints (O3 and O1) top out at 1080p and have no 4K variant,
 * so upscaling is the only route to a 2K or 4K master from reference mode —
 * which is also the only mode that gives character consistency across shots.
 * Generate at Pro, keep the good ones, upscale those.
 */

import { roundChargeCents } from "./pricing";

export type UpscaleTarget = "2k" | "4k";

/**
 * fal bills Topaz by output resolution: $0.01/s up to 720p, $0.02/s to 1080p,
 * $0.08/s above that. Every target here lands above 1080p, so one rate covers
 * both. Doubles for 60fps output — we never request frame interpolation.
 */
export const UPSCALE_CENTS_PER_SECOND = 8;

/** Multipliers against the 1080p master, not absolute resolutions. */
export const UPSCALE_FACTOR: Record<UpscaleTarget, number> = {
  "2k": 1.34,
  "4k": 2,
};

export const UPSCALE_LABEL: Record<UpscaleTarget, string> = {
  "2k": "2K",
  "4k": "4K",
};

export const UPSCALE_TARGETS: UpscaleTarget[] = ["2k", "4k"];

export function isUpscaleTarget(v: unknown): v is UpscaleTarget {
  return v === "2k" || v === "4k";
}

export function upscaleCostCents(durationSeconds: number): number {
  return Math.round(UPSCALE_CENTS_PER_SECOND * durationSeconds);
}

/**
 * What the customer is charged for an upscale, in cents.
 *
 * Marked up like a generation, and rounded to the same credit granularity so
 * the figure on the button matches what leaves their balance.
 */
export function upscaleChargeCents(durationSeconds: number): number {
  const markup = Number(process.env.NEXT_PUBLIC_PRICE_MARKUP ?? 1.8);
  const rate = Number.isFinite(markup) && markup > 0 ? markup : 1.8;
  return roundChargeCents(upscaleCostCents(durationSeconds) * rate);
}
