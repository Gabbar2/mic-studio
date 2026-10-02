import type { GenerationMode, Quality } from "./models";

/**
 * Three account tiers, not two.
 *
 * `trial` (anonymous, see lib/anon.ts) and `unlocked` (a subscriber or anyone
 * who has ever bought a credit pack) already existed in spirit. This file adds
 * the tier in between: a real, signed-up, *free* account. It is not the
 * anonymous trial — it has an email, its clips are saved, native audio works —
 * but it is not fully open either. Reference-to-video, Pro/4K, and the
 * longest (15s) duration are held back as the specific, nameable reasons to
 * subscribe or buy credits, the same way duration/quality/audio are held back
 * during the anonymous trial to make an account.
 */
export type AccountTier = "trial" | "free" | "unlocked";

export const FREE_QUALITY: Quality = "std";
export const FREE_DURATIONS = [5, 10] as const;
export const FREE_MODES: GenerationMode[] = ["text2video", "image2video"];

export interface TierViolation {
  message: string;
  /** Which upgrade ask this maps to in the UI — see lib/trialLocks. */
  lock: "quality" | "duration" | "reference";
}

/**
 * Refuses on shape, same reasoning as anon.ts's checkTrialShape: telling a
 * free-tier account "insufficient credit" for something their balance would
 * otherwise cover is the wrong message. This runs only for signed-in accounts
 * that are neither anonymous nor unlocked (see credits.ts's isUnlockedAccount).
 */
export function checkFreeTierShape(input: {
  mode: GenerationMode;
  quality: Quality;
  durationSeconds: number;
}): TierViolation | null {
  if (!FREE_MODES.includes(input.mode)) {
    return {
      message:
        "Reference-to-video needs a subscription or a credit purchase. Upgrade to unlock it.",
      lock: "reference",
    };
  }
  if (input.quality !== FREE_QUALITY) {
    return {
      message:
        "Pro and 4K need a subscription or a credit purchase. Upgrade to unlock them.",
      lock: "quality",
    };
  }
  if (!(FREE_DURATIONS as readonly number[]).includes(input.durationSeconds)) {
    return {
      message:
        "15-second clips need a subscription or a credit purchase. Upgrade to unlock them.",
      lock: "duration",
    };
  }
  return null;
}
