import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/consent";

export const runtime = "nodejs";

/**
 * Issues a one-time signed upload URL for the `uploads` bucket.
 *
 * The file itself never passes through this server. That is deliberate:
 * serverless request bodies are capped around 4.5 MB, which a reference video
 * blows past immediately. The browser uploads straight to Supabase Storage.
 *
 * Security is unchanged — the bucket still has no client insert policy. The
 * server picks the path and mints a single-use token, so a holder of the
 * publishable key still cannot write anywhere it chooses.
 *
 * Consent is enforced here rather than in the UI. A checkbox in the browser is
 * a courtesy; anyone can POST to this endpoint directly. Refusing without it,
 * and writing the record in the same breath as minting the URL, is what makes
 * the log complete — there is no path that produces a file with no record.
 */

const LIMITS = {
  image: {
    exts: new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]),
    maxBytes: 20 * 1024 * 1024,
  },
  video: {
    exts: new Set(["mp4", "mov"]),
    maxBytes: 200 * 1024 * 1024,
  },
} as const;

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: {
    kind?: string;
    ext?: string;
    size?: number;
    consent?: boolean;
    consentVersion?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Refuse before doing anything else. Nothing is signed, nothing is stored,
  // and the error names the checkbox rather than talking about policy.
  if (body.consent !== true) {
    return NextResponse.json(
      {
        error:
          "Confirm you have the right to use this file before uploading it.",
        code: "consent_required",
      },
      { status: 403 },
    );
  }

  // A client sending an old version string has a stale bundle cached. Take the
  // upload, but record what they were actually shown, never what we show now.
  const consentVersion =
    typeof body.consentVersion === "string" && body.consentVersion.length <= 40
      ? body.consentVersion
      : CONSENT_VERSION;

  const kind = body.kind === "video" ? "video" : "image";
  const ext = String(body.ext ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const size = Number(body.size ?? 0);
  const rule = LIMITS[kind];

  if (!rule.exts.has(ext as never)) {
    return NextResponse.json(
      { error: `Unsupported ${kind} format: .${ext || "?"}` },
      { status: 415 },
    );
  }
  if (!Number.isFinite(size) || size <= 0 || size > rule.maxBytes) {
    return NextResponse.json(
      { error: `File too large (max ${rule.maxBytes / 1024 / 1024} MB).` },
      { status: 413 },
    );
  }

  const admin = createAdminClient();
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { data, error } = await admin.storage
    .from("uploads")
    .createSignedUploadUrl(path);

  if (error || !data) {
    console.error("[upload/sign]", error);
    return NextResponse.json(
      { error: error?.message ?? "Could not prepare upload" },
      { status: 500 },
    );
  }

  // Written after the URL is minted so a storage failure does not leave a
  // consent record for a file that never existed. A failure here is logged and
  // swallowed: the upload is already authorised, and losing the render would
  // punish the user for our bookkeeping.
  const fwd = req.headers.get("x-forwarded-for");
  const { error: consentError } = await admin.from("upload_consents").insert({
    user_id: user.id,
    storage_path: path,
    kind,
    consent_version: consentVersion,
    consent_text: CONSENT_TEXT,
    ip: fwd ? fwd.split(",")[0]!.trim().slice(0, 60) : null,
    user_agent: req.headers.get("user-agent")?.slice(0, 400) ?? null,
  });
  if (consentError) console.error("[upload/consent]", consentError);

  const { data: pub } = admin.storage.from("uploads").getPublicUrl(path);

  return NextResponse.json(
    { path, token: data.token, publicUrl: pub.publicUrl },
    { status: 201 },
  );
}
