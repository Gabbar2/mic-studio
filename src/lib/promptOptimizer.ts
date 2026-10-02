/**
 * Rule-based prompt cleanup — no LLM, no API key, no network call.
 *
 * Built after a real submission came back with a provider-side 422 for a
 * prompt that (a) named a real trademarked product by its exact model name,
 * and (b) instructed the model to bio-identically preserve a specific real
 * person's "identity, skin tone, hands, fingers, hair" from an uploaded
 * photo. Both read to an automated content filter as "reproduce this real,
 * identifiable thing exactly" rather than as ordinary creative direction.
 *
 * This is deliberately NOT an AI rewrite. It only catches the two concrete
 * patterns above (plus the plain character-limit check every model already
 * enforces), and different providers draw their moderation line in different
 * places — clearing every flag here reduces the odds of a rejection, it does
 * not guarantee any provider accepts the result.
 */

export interface PromptFlag {
  kind: "brand" | "likeness" | "length";
  message: string;
}

export interface OptimizeResult {
  cleaned: string;
  flags: PromptFlag[];
  changed: boolean;
}

// Exact model name -> generic descriptor. Short and manually curated on
// purpose: a giant auto-scraped trademark list is a maintenance burden and
// would still miss things, so this covers the brands most likely to show up
// in a consumer-product video prompt rather than trying to be exhaustive.
// Order matters — a specific product pattern (e.g. "Galaxy Z Fold8") must be
// checked before the bare brand name ("Samsung"), or the specific match never
// fires because the brand-only pattern already consumed the text around it.
const BRAND_REPLACEMENTS: [RegExp, string][] = [
  [/\bgalaxy z fold\s*\d*\b/gi, "a premium foldable smartphone"],
  [/\bgalaxy z flip\s*\d*\b/gi, "a premium flip smartphone"],
  [/\bgalaxy buds\s*\d*\s*(pro)?\b/gi, "premium wireless earbuds"],
  [/\bgalaxy s\d+\s*(ultra|plus|\+)?\b/gi, "a flagship smartphone"],
  [/\biphone\s*\d*\s*(pro|max|plus)?\b/gi, "a flagship smartphone"],
  [/\bairpods\s*(pro|max)?\b/gi, "wireless earbuds"],
  [/\bmacbook\s*(air|pro)?\b/gi, "a laptop"],
  [/\bapple\s+watch\b/gi, "a smartwatch"],
  [/\bpixel\s*\d*\s*(pro)?\b/gi, "a smartphone"],
  [/\bplaystation\s*\d*\b/gi, "a gaming console"],
  [/\bxbox\b/gi, "a gaming console"],
  [/\btesla\b/gi, "an electric vehicle brand"],
  [/\bcoca-?cola\b/gi, "a beverage brand"],
  [/\bsamsung\b/gi, "a premium tech brand"],
  [/\bapple\b/gi, "a premium tech brand"],
  [/\bsony\b/gi, "a premium electronics brand"],
  [/\bnike\b/gi, "an athletic brand"],
  [/\badidas\b/gi, "an athletic brand"],
];

// "preserve/keep her identity" (or "his"/"the woman's"/"the model's") —
// the phrasing that asks for a real, identifiable person to be reproduced
// exactly, as opposed to ordinary continuity direction like "keep her outfit
// the same".
const LIKENESS_PATTERN =
  /\b(preserve|keep|maintain)[^.]{0,60}\b(her|his|the (woman|man|person|model)('s)?)\b[^.]{0,80}\b(identity|likeness)\b/i;

// A sentence that strings together two or more literal biometric details
// (skin tone, hands, fingers, hair, face) as things to keep "consistent" —
// the itemised-body-parts pattern from the rejected prompt, distinct from a
// single incidental mention of e.g. "her hair" in passing.
const BIOMETRIC_LIST_PATTERN =
  /\b(skin tone|fingers?|hands?)\b[^.]{0,120}\b(hands?|fingers?|hair|face)\b/i;

export function optimizePrompt(prompt: string, maxChars: number): OptimizeResult {
  const flags: PromptFlag[] = [];
  let cleaned = prompt;

  for (const [pattern, replacement] of BRAND_REPLACEMENTS) {
    const match = cleaned.match(pattern);
    if (match) {
      flags.push({
        kind: "brand",
        message: `Names a real product/brand ("${match[0].trim()}") — some providers reject requests that name trademarked products by exact model.`,
      });
      cleaned = cleaned.replace(pattern, replacement);
    }
  }

  if (LIKENESS_PATTERN.test(cleaned) || BIOMETRIC_LIST_PATTERN.test(cleaned)) {
    flags.push({
      kind: "likeness",
      message:
        "Instructs the model to bio-identically preserve a real person's identity/skin tone/fingers/hair from a photo — likeness filters can reject this even with the consent box checked.",
    });
    cleaned = cleaned
      .replace(
        LIKENESS_PATTERN,
        "keep the subject's appearance and styling consistent",
      )
      .replace(
        BIOMETRIC_LIST_PATTERN,
        "the subject's appearance and pose consistent",
      );
  }

  if (cleaned.length > maxChars) {
    flags.push({
      kind: "length",
      message: `${cleaned.length - maxChars} characters over this model's ${maxChars}-character limit — the server rejects this outright, before it ever reaches the provider.`,
    });
  }

  return { cleaned, flags, changed: cleaned !== prompt };
}
