import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import ReferenceEditor from "@/components/reference-editor/ReferenceEditor";

export const dynamic = "force-dynamic";

/**
 * The Reference Editor — a separate page from /studio, not a tab inside it.
 * It prepares a real, trimmed reference video (and, later, detected scenes,
 * objects and prompts) and hands the result to Studio; it never generates or
 * spends credit itself (see ReferenceEditor's own doc comment and the
 * "Continue in Mic Studio" button).
 *
 * Gated to a real signed-in account rather than offered to anonymous trial
 * visitors the way Studio is: uploading the prepared clip needs a session,
 * and Studio already owns the one place that bootstraps an anonymous account
 * on first use (`ensureSession`, wired through `setSessionEnsurer`). Rather
 * than duplicate that bootstrapping here for a page a trial visitor has no
 * real use for anyway (they can't yet reach reference mode in Studio — see
 * FREE_MODES in lib/freeTier.ts), this just asks them to sign in from Studio
 * first.
 */
export default async function ReferenceEditorPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.is_anonymous) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ink-950 px-6 text-center">
        <p className="text-sm text-ink-300">
          Sign in from the Studio first — the Reference Editor needs an
          account to store the clips it prepares for you.
        </p>
        <Link
          href="/studio"
          className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-400"
        >
          Go to Studio →
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink-950">
      <ReferenceEditor />
    </main>
  );
}
