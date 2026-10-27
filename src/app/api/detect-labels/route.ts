import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { detectCandidateLabels } from "@/lib/providers/fal";
import { ProviderError } from "@/lib/providers";

export const runtime = "nodejs";

/**
 * Auto-detect candidate object/background labels for the Reference Editor's
 * select-objects step, shown as clickable pills above the frame so a person
 * isn't stuck typing every description from scratch. Server-side only for
 * the same reason as /api/segment: this is the one place FAL_KEY can live,
 * and it's a billed call, so it's gated to signed-in users.
 *
 * Deliberately a separate, best-effort endpoint from /api/segment: a failure
 * here (no labels found, Florence-2 having a bad moment) should never block
 * the rest of the selector — the caller falls back to manual typing — so it
 * stays its own small route rather than a mode flag on segment's contract.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }

  const { imageUrl } = (body ?? {}) as { imageUrl?: unknown };

  if (typeof imageUrl !== "string" || !imageUrl) {
    return NextResponse.json(
      { error: "Expected { imageUrl: string }" },
      { status: 400 },
    );
  }

  try {
    const labels = await detectCandidateLabels(imageUrl);
    return NextResponse.json({ labels }, { status: 200 });
  } catch (e) {
    console.error("[detect-labels]", e);
    const message =
      e instanceof ProviderError ? e.message : "Could not auto-detect objects.";
    const status = e instanceof ProviderError ? (e.httpStatus ?? 502) : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
