/**
 * What a trial visitor is stopped by, and what to say when they hit it.
 *
 * The first build hid these controls. That was the wrong instinct: a person
 * who never sees Pro has no reason to want it, and the composer read as a
 * cheap tool rather than a restricted one. Showing every control and asking
 * for an email at the moment someone reaches for one turns each limit into the
 * pitch — they have already decided they want the thing before being asked.
 *
 * The copy matters more than the mechanism. Each message names what they just
 * reached for, not a generic "sign up to continue", because the specific ask is
 * the one that converts.
 */
export type TrialLock =
  | "duration"
  | "quality"
  | "audio"
  | "image2video"
  | "reference"
  | "model"
  | "quota"
  | "budget";

export interface LockCopy {
  /** Headline. Names the thing they just clicked. */
  title: string;
  /** One line of why. Never scolding — they did nothing wrong. */
  body: string;
  /** The button. */
  cta: string;
}

export const LOCK_COPY: Record<TrialLock, LockCopy> = {
  duration: {
    title: "Other lengths need an account",
    body: "Your free clip is 5 seconds. Add your email to choose 10 or 15 seconds instead.",
    cta: "Unlock other lengths",
  },
  quality: {
    title: "Pro and 4K need an account",
    body: "The free clip renders at Standard. Add your email to unlock Pro and native 4K.",
    cta: "Unlock Pro and 4K",
  },
  audio: {
    title: "Native audio needs an account",
    body: "Kling generates sound with the picture — dialogue, ambience, effects. Add your email to switch it on.",
    cta: "Unlock audio",
  },
  image2video: {
    title: "Image-to-video needs an account",
    body: "Turn a photo into motion. Add your email to try it.",
    cta: "Unlock image-to-video",
  },
  reference: {
    title: "Reference to video needs an account",
    body: "Feed in a clip and your own images to carry a look across shots. Add your email to try it.",
    cta: "Unlock references",
  },
  model: {
    title: "Other models need an account",
    body: "The free clip runs on Kling. Add your email to also try Wan and other models.",
    cta: "Unlock other models",
  },
  quota: {
    title: "That was your free clip",
    body: "Add your email to keep it and carry on generating. Your clip stays exactly where it is — same account, nothing to move.",
    cta: "Keep my clip",
  },
  budget: {
    title: "Free clips are all used up for today",
    body: "The daily free allowance has run out. It resets at midnight UTC — or add your email now and generate straight away.",
    cta: "Continue with an account",
  },
};

/** Everything an account opens up, listed once in the modal. */
export const UNLOCKS = [
  "Image-to-video",
  "10 and 15-second clips",
  "Pro and native 4K",
  "Generated audio",
  "Reference to video",
  "Other AI models, like Wan",
  "Your clips saved to a gallery",
] as const;

/**
 * Maps an API error code to the lock it corresponds to.
 *
 * `trial_shape` should be unreachable from our own UI — every restricted
 * control is intercepted before it can change the value — so it is mapped
 * defensively rather than expectantly. If it ever fires, something in the
 * composer has drifted out of step with the server.
 */
export function lockForErrorCode(code: string | undefined): TrialLock | null {
  switch (code) {
    case "insufficient_credit":
    case "quota_exceeded":
      return "quota";
    case "trial_budget_spent":
      return "budget";
    case "trial_shape":
      return "quality";
    default:
      return null;
  }
}

/**
 * The free tier's own three caps (see lib/freeTier.ts). A separate, smaller
 * copy table from LOCK_COPY above — the ask here is "subscribe or buy
 * credits", not "add an email", because a free-tier account already has one.
 * Rendered by UpgradePrompt, never SignInPrompt.
 */
export type UpgradeLock = "quality" | "duration" | "reference";

export const UPGRADE_LOCK_COPY: Record<UpgradeLock, LockCopy> = {
  quality: {
    title: "Pro and 4K need an upgrade",
    body: "The free tier renders at Standard. Subscribe or buy credits to unlock Pro and native 4K.",
    cta: "See plans",
  },
  duration: {
    title: "15-second clips need an upgrade",
    body: "The free tier goes up to 10 seconds. Subscribe or buy credits to unlock 15-second clips.",
    cta: "See plans",
  },
  reference: {
    title: "Reference-to-video needs an upgrade",
    body: "Feed in a clip and your own images to carry a look across shots. Subscribe or buy credits to try it.",
    cta: "See plans",
  },
};
