import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_PATH = "retention-report.csv";
const COLUMNS = [
  "email",
  "deadline",
  "template_key",
  "status",
  "clip_count_at_send",
  "sent_at",
  "send_error",
  "cleaned_at",
  "cleaned_clip_count",
  "created_at",
] as const;

/** Quotes a field only when it needs it — same minimal-quoting behavior
 * every spreadsheet app's own CSV export uses, so the file reads cleanly
 * whether it's opened in Excel, Numbers, or Google Sheets. */
function csvField(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Regenerates the full campaign audit log as CSV — every notice ever sent
 * or cleaned, not just this session's — and saves it to the private
 * "admin-reports" storage bucket, then hands back a short-lived signed URL
 * to download it. A plain CSV rather than a true .xlsx binary: Excel,
 * Numbers, and Google Sheets all open it natively, and it needs no new npm
 * dependency in a build that has already broken twice this week over
 * misplaced files — one less thing that can go wrong in that pipeline.
 */
export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;

  const { data: rows, error } = await admin
    .from("retention_notices")
    .select(
      "email, deadline, template_key, status, clip_count_at_send, sent_at, send_error, cleaned_at, cleaned_clip_count, created_at",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const lines = [
    COLUMNS.join(","),
    ...(rows ?? []).map((r) =>
      COLUMNS.map((c) =>
        csvField((r as unknown as Record<string, unknown>)[c]),
      ).join(","),
    ),
  ];
  const csv = lines.join("\n");

  const { error: uploadError } = await admin.storage
    .from("admin-reports")
    .upload(REPORT_PATH, new Blob([csv], { type: "text/csv" }), {
      upsert: true,
      contentType: "text/csv",
    });
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: signed, error: signError } = await admin.storage
    .from("admin-reports")
    .createSignedUrl(REPORT_PATH, 300);
  if (signError || !signed) {
    return NextResponse.json(
      { error: signError?.message ?? "Could not sign the report URL" },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: signed.signedUrl, rowCount: rows?.length ?? 0 });
}
