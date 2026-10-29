import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { extractYouTubeVideoId, getVideoLicense } from "@/lib/youtube";

export const runtime = "nodejs";

/**
 * Checks a pasted YouTube link's declared license before the Reference
 * Editor does anything else with it. Called instead of trying to load the
 * link as a video — YouTube blocks direct playback outside its own player
 * regardless of license, so the only thing worth telling the person is
 * whether they're even allowed to reuse this video at all, via some other,
 * legitimate route. See the ReferenceEditor.tsx doc comment at the call
 * site for exactly what happens with each result.
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

  const { url } = (body ?? {}) as { url?: unknown };
  if (typeof url !== "string" || !url) {
    return NextResponse.json(
      { error: "Expected { url: string }" },
      { status: 400 },
    );
  }

  const videoId = extractYouTubeVideoId(url);
  if (!videoId) {
    return NextResponse.json(
      { error: "That doesn't look like a YouTube link." },
      { status: 400 },
    );
  }

  try {
    const license = await getVideoLicense(videoId);
    return NextResponse.json({ videoId, license }, { status: 200 });
  } catch (e) {
    console.error("[youtube-license]", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error
            ? e.message
            : "Could not check that video's license.",
      },
      { status: 502 },
    );
  }
}
