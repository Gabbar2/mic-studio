"use client";

import { useState } from "react";
import { optimizePrompt, type PromptFlag } from "@/lib/promptOptimizer";

/**
 * A manual check, not an auto-clean. It never touches the prompt until the
 * person clicks "Use this version" — see the earlier decision to keep this
 * opt-in rather than silently rewriting words someone typed.
 */
export default function PromptOptimizer({
  prompt,
  maxChars,
  onApply,
}: {
  prompt: string;
  maxChars: number;
  onApply: (cleaned: string) => void;
}) {
  const [result, setResult] = useState<{
    cleaned: string;
    flags: PromptFlag[];
  } | null>(null);

  function run() {
    setResult(optimizePrompt(prompt, maxChars));
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={run}
        disabled={!prompt.trim()}
        className="rounded-md border border-ink-700 px-2 py-1 text-[11px] text-ink-200 transition hover:border-accent-500 hover:text-accent-400 disabled:opacity-40"
      >
        Check for moderation risks
      </button>

      {result && (
        <div className="mt-2 rounded-lg border border-ink-700 bg-ink-900/60 p-3">
          {result.flags.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-ink-400">
              No known risk patterns found — that doesn&rsquo;t guarantee a
              provider will accept this prompt, only that it doesn&rsquo;t
              match the specific things that have caused rejections before.
            </p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {result.flags.map((f, i) => (
                  <li
                    key={i}
                    className="text-[11px] leading-relaxed text-amber-300/90"
                  >
                    {f.message}
                  </li>
                ))}
              </ul>

              <p className="mt-2.5 text-[10px] font-medium uppercase tracking-wide text-ink-400">
                Suggested rewrite
              </p>
              <p className="mt-1 rounded-md border border-ink-700 bg-ink-850 p-2 text-[11px] leading-relaxed text-ink-200">
                {result.cleaned}
              </p>

              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onApply(result.cleaned);
                    setResult(null);
                  }}
                  className="rounded-md bg-accent-500 px-2.5 py-1 text-[11px] font-medium text-accent-ink transition hover:bg-accent-400"
                >
                  Use this version
                </button>
                <button
                  type="button"
                  onClick={() => setResult(null)}
                  className="rounded-md border border-ink-700 px-2.5 py-1 text-[11px] text-ink-300 transition hover:border-ink-600"
                >
                  Keep mine
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
