import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Stores a poster frame for a finished generation.
 *
 * The frame itself is captured in the browser (see ThumbnailBackfill) because
 * decoding video server-side would mean shipping ffmpeg, which doesn't exist on
 * a serverless runtime. The capture happens once per clip; every load after
 * that is a small JPEG instead of a 23 Mbps MP4.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected form data" }, { status: 400 });
  }

  const generationId = form.get("generationId");
  const file = form.get("file");

  if (typeof generationId !== "string" || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing fields" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Thumbnail too large" }, { status: 413 });
  }

  const admin = createAdminClient();

  // Ownership check — the id comes from the client, so it is not trusted.
  const { data: row } = await admin
    .from("generations")
    .select("id, user_id")
    .eq("id", generationId)
    .maybeSingle();

  if (!row || row.user_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const path = `thumbs/${generationId}.jpg`;

  const { error } = await admin.storage
    .from("uploads")
    .upload(path, new Uint8Array(await file.arrayBuffer()), {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (error) {
    console.error("[thumbnail]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = admin.storage.from("uploads").getPublicUrl(path);

  await admin
    .from("generations")
    .update({ thumbnail_url: data.publicUrl })
    .eq("id", generationId);

  return NextResponse.json({ url: data.publicUrl }, { status: 201 });
}
