import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { editElementImage } from "@/lib/providers/openai";
import { isMockElementEditEnabled } from "@/lib/elementEditSettings";

export const runtime = "nodejs";

/**
 * Generates one element's actual edited frame — the ✨ chat's "Send" button
 * in SceneObjectSelector.tsx. Billed to OPENAI_API_KEY when real, so this is
 * gated the same way every other paid action in this app is: signed-in
 * users only, and checked against the admin-controlled mock switch (see
 * lib/elementEditSettings.ts) before anything is ever sent to OpenAI.
 *
 * Mock mode hands back `imageUrl` completely unchanged, flagged
 * `mock: true` — no model call, no charge. That's deliberate: it exercises
 * the exact same request/response shape and the exact same UI path (a
 * result bubble appears, Save still works, Continue in Mic Studio still
 * picks it up) as the real thing, so the whole feature can be tested for
 * free before an admin ever turns real generation on.
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

  const { imageUrl, maskUrl, prompt } = (body ?? {}) as {
    imageUrl?: unknown;
    maskUrl?: unknown;
    prompt?: unknown;
  };

  if (
    typeof imageUrl !== "string" ||
    !imageUrl ||
    typeof maskUrl !== "string" ||
    !maskUrl ||
    typeof prompt !== "string" ||
    !prompt.trim()
  ) {
    return NextResponse.json(
      { error: "Expected { imageUrl: string, maskUrl: string, prompt: string }" },
      { status: 400 },
    );
  }

  const mock = await isMockElementEditEnabled();
  if (mock) {
    return NextResponse.json({ url: imageUrl, mock: true }, { status: 200 });
  }

  try {
    const { bytes } = await editElementImage({
      imageUrl,
      maskUrl,
      prompt: prompt.trim(),
    });

    // Mirrored into our own storage rather than handed back as-is, same
    // reasoning as mirrorToStorage() in lib/generations.ts: OpenAI's
    // response is either a short-lived URL or a base64 blob, and this image
    // needs a stable, permanent https URL once it's attached to an element
    // and eventually sent to Kling or Wan as a reference.
    const admin = createAdminClient();
    const path = `${user.id}/edits/${crypto.randomUUID()}.png`;
    const { error } = await admin.storage
      .from("uploads")
      .upload(path, bytes, { contentType: "image/png", upsert: true });
    if (error) throw new Error(error.message);

    const { data } = admin.storage.from("uploads").getPublicUrl(path);
    return NextResponse.json(
      { url: data.publicUrl, mock: false },
      { status: 200 },
    );
  } catch (e) {
    console.error("[edit-element]", e);
    return NextResponse.json(
      {
        error:
          e instanceof Error ? e.message : "Could not generate that edit.",
      },
      { status: 502 },
    );
  }
}
