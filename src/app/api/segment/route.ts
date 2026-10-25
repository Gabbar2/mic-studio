import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { segmentByPrompt } from "@/lib/providers/fal";
import { ProviderError } from "@/lib/providers";

export const runtime = "nodejs";

/**
 * Object/background segmentation for the Reference Editor's select-to-keep
 * step. Server-side only because this is the one place `FAL_KEY` can live —
 * never in frontend code, per the original spec's own rule, and unlike the
 * ffmpeg trimming (which only ever touches jsdelivr's public files), this
 * call is billed per request, so it's gated to signed-in users same as
 * every other paid action in this app.
 *
 * Takes a text description, not a click point — SAM 3 is a text-concept
 * segmentation model (see the doc comment on segmentByPrompt in
 * lib/providers/fal.ts for why a point-only version of this route didn't
 * actually detect anything).
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

  const { imageUrl, prompt } = (body ?? {}) as {
    imageUrl?: unknown;
    prompt?: unknown;
  };

  if (
    typeof imageUrl !== "string" ||
    !imageUrl ||
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {
    return NextResponse.json(
      { error: "Expected { imageUrl: string, prompt: string }" },
      { status: 400 },
    );
  }

  try {
    const result = await segmentByPrompt(imageUrl, prompt.trim());
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    console.error("[segment]", e);
    const message =
      e instanceof ProviderError ? e.message : "Segmentation failed.";
    const status = e instanceof ProviderError ? (e.httpStatus ?? 502) : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
