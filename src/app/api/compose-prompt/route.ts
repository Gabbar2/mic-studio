import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { composeReferencePrompt } from "@/lib/providers/promptWriter";

export const runtime = "nodejs";

/**
 * Writes the Reference → Video prompt for the Reference Editor's "Continue
 * in Mic Studio" hand-off — see lib/providers/promptWriter.ts for the real
 * work. Billed to OPENAI_API_KEY, so gated the same way every other paid
 * action in this app is: signed-in users only.
 *
 * No mock-mode switch here the way /api/edit-element has one — a failed or
 * skipped call here isn't a dead end the way a missing edited image would
 * be, since the caller (ReferenceEditor's continueInStudio) already falls
 * back to the plain concatenated prompt it always used to send on any
 * error from this route, so Continue in Mic Studio never actually blocks
 * on this.
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

  const { aspectRatio, motionFrameDataUrls, beats } = (body ?? {}) as {
    aspectRatio?: unknown;
    motionFrameDataUrls?: unknown;
    beats?: unknown;
  };

  const beatsValid =
    Array.isArray(beats) &&
    beats.length > 0 &&
    beats.every(
      (b): b is { imageUrl: string; headline: string | null } =>
        !!b &&
        typeof b === "object" &&
        typeof (b as { imageUrl?: unknown }).imageUrl === "string" &&
        ((b as { headline?: unknown }).headline === null ||
          typeof (b as { headline?: unknown }).headline === "string"),
    );

  if (
    typeof aspectRatio !== "string" ||
    !aspectRatio ||
    !Array.isArray(motionFrameDataUrls) ||
    !motionFrameDataUrls.every((u) => typeof u === "string") ||
    !beatsValid
  ) {
    return NextResponse.json(
      {
        error:
          "Expected { aspectRatio: string, motionFrameDataUrls: string[], beats: { imageUrl: string, headline: string | null }[] }",
      },
      { status: 400 },
    );
  }

  try {
    const prompt = await composeReferencePrompt({
      aspectRatio,
      motionFrameDataUrls,
      beats,
    });
    return NextResponse.json({ prompt }, { status: 200 });
  } catch (e) {
    console.error("[compose-prompt]", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Could not compose a prompt.",
      },
      { status: 502 },
    );
  }
}
