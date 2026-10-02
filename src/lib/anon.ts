import { createAdminClient } from "./supabase/admin";
import { DEFAULT_MODEL_ID, type GenerationMode, type Quality } from "./models";

/**
 * The anonymous trial.
 *
 * A visitor gets one clip before being asked for anything. The whole design
 * rests on a single observation: you cannot reliably tell one stranger from
 * another on the web. A cookie is cleared in a second, an IP address is shared
 * by an entire mobile network, and a device fingerprint loses to a second
 * browser. Every per-person control leaks, and every one of them also blocks
 * real people who did nothing wrong.
 *
 * So the per-person limits here are deliberately soft — enough to stop casual
 * repetition — and the actual protection is the daily budget below, which
 * bounds the loss no matter how many identities one person creates.
 */

/** Exactly one Standard 5s silent text-to-video clip: 750 credits at a 1.8x markup. */
export function anonGrantCents(): number {
  const raw = Number(process.env.ANON_GRANT_CENTS ?? 75);
  return Number.isFinite(raw) && raw >= 0 ? raw : 75;
}

/**
 * Total provider cost the trial may spend across every anonymous visitor in a
 * day. At $3 and $0.42 a clip that is roughly seven free clips daily, and a
 * worst case you can look at without flinching.
 */
export function anonDailyBudgetCents(): number {
  const raw = Number(process.env.ANON_DAILY_BUDGET_CENTS ?? 300);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300;
}

/**
 * What a trial clip is allowed to be.
 *
 * The grant alone would mostly enforce this — 1,500 credits does not stretch
 * to Pro, 4K, or a second mode — but "insufficient credit" is the wrong thing
 * to tell someone who has not been asked for money yet. Refusing on shape lets
 * the message say what the trial is instead.
 *
 * Text-to-video only, on purpose: image-to-video and reference-to-video are
 * both held back as the specific, nameable reasons to make an account,
 * exactly like duration, quality and audio already are below.
 */
export const TRIAL_QUALITY: Quality = "std";
export const TRIAL_DURATION_SECONDS = 5;
export const TRIAL_AUDIO = false;
export const TRIAL_MODE: GenerationMode = "text2video";

/**
 * The trial is also pinned to one model, not just one shape.
 *
 * The 75-cent grant is sized to cost exactly one Kling Standard 5s silent
 * clip (750 credits) — that exact match is what makes "one free clip" true
 * without a separate counter. A cheaper model (Wan) would leave change in
 * the grant after the first clip and quietly turn the trial into "however
 * many cheap clips 75 cents buys." Locking the model keeps the economics
 * that simple; other models stay a reason to sign in, same as duration,
 * quality and audio already are.
 */
export const TRIAL_MODEL_ID = DEFAULT_MODEL_ID;

export interface TrialViolation {
  message: string;
}

export function checkTrialShape(input: {
  mode: GenerationMode;
  quality: Quality;
  durationSeconds: number;
  withAudio: boolean;
  modelId: string;
}): TrialViolation | null {
  if (input.modelId !== TRIAL_MODEL_ID) {
    return {
      message: "The free trial runs on Kling. Sign in to try other models.",
    };
  }
  if (input.mode !== TRIAL_MODE) {
    return {
      message:
        input.mode === "image2video"
          ? "The free trial is text-to-video only. Sign in to unlock image-to-video."
          : "The free trial is text-to-video only. Sign in to unlock reference-to-video.",
    };
  }
  if (input.quality !== TRIAL_QUALITY) {
    return {
      message:
        "The free clip is Standard quality. Sign in to unlock Pro and 4K.",
    };
  }
  if (input.durationSeconds !== TRIAL_DURATION_SECONDS) {
    return {
      message: "The free clip is 5 seconds. Sign in for other lengths.",
    };
  }
  if (input.withAudio) {
    return {
      message: "The free clip is silent. Sign in to generate audio.",
    };
  }
  return null;
}

/** Provider cost already spent by anonymous visitors today. */
export async function anonSpendTodayCents(): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.rpc("anon_spend_today");
  return typeof data === "number" ? data : 0;
}

/**
 * True when today's free clips have used up the budget.
 *
 * Reads live rather than caching: it is one indexed sum, it only runs on the
 * anonymous path, and being wrong here costs real money.
 */
export async function trialBudgetSpent(nextClipCents: number): Promise<boolean> {
  const budget = anonDailyBudgetCents();
  if (budget <= 0) return true;
  const spent = await anonSpendTodayCents();
  return spent + nextClipCents > budget;
}
