/**
 * A short, scannable label for a clip, derived from its prompt.
 *
 * Deliberately not a model call: a title is worth roughly nothing on its own,
 * and paying per clip — plus a round trip before the card can render — to get
 * one would be a bad trade. Cutting the prompt at its first natural boundary
 * gets most of the value for free and stays predictable, which matters more
 * than elegance when you are scanning sixty tiles for the one you meant.
 */

const MAX = 52;
/** Cutting here would leave a fragment, so these get trimmed off the end. */
const TRAILING = /\s+(?:a|an|the|and|or|but|with|of|in|on|at|to|for|from|by|as|is|its|his|her|their)$/i;

export function shortTitle(prompt: string | null | undefined): string {
  if (!prompt) return "Untitled clip";

  // Strip markdown emphasis and smart quotes people paste in, then flatten
  // newlines — a prompt written across three lines is still one sentence.
  const clean = prompt
    .replace(/[*_`#>]+/g, " ")
    .replace(/[""'']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return "Untitled clip";

  const cut = firstBoundary(clean);
  const title = cut.replace(TRAILING, "").replace(/[\s,;:.\-–—]+$/, "");

  if (!title) return "Untitled clip";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * Prefers a real sentence break, then a clause break, and only falls back to
 * chopping at a word boundary. The lower bounds stop "35mm." or "Wide." from
 * becoming the whole title.
 */
function firstBoundary(s: string): string {
  const sentence = s.search(/[.!?](?:\s|$)/);
  if (sentence >= 12 && sentence <= MAX) return s.slice(0, sentence);

  const clause = s.search(/[,;:—–]/);
  if (clause >= 12 && clause <= MAX) return s.slice(0, clause);

  if (s.length <= MAX) return s;

  const chopped = s.slice(0, MAX);
  const lastSpace = chopped.lastIndexOf(" ");
  return lastSpace > 20 ? chopped.slice(0, lastSpace) : chopped;
}
