/**
 * Cuts text down to at most `max` characters without leaving it hanging
 * mid-word — backs up to the last whitespace before the limit when one
 * exists in the trimmed range, same shape as a normal "read more" ellipsis
 * truncation.
 *
 * Shared by lib/providers/promptWriter.ts (the defensive cap on the AI
 * prompt-writer's own output) and ReferenceEditor.tsx (the same cap on the
 * plain-concatenation fallback prompt, which never goes through that
 * server-only module at all) — kept in its own tiny, client-safe file so a
 * client component needing just this one string helper doesn't have to
 * import promptWriter.ts and pull its OpenAI call into the browser bundle.
 */
export function truncateToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}
