import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_PATH = "users-report.csv";
const COLUMNS = [
  "email",
  "display_name",
  "is_admin",
  "joined_at",
  "last_seen_at",
  "confirmed",
  "clips",
  "credits_left_usd",
] as const;

/** Quotes a field only when it needs it — same minimal-quoting behavior
 * every spreadsheet app's own CSV export uses, so the file reads cleanly
 * whether it's opened in Excel, Numbers, or Google Sheets. Same helper as
 * the retention export route (api/admin/retention/export/route.ts) —
 * duplicated rather than shared, since these two routes are the only
 * callers and a shared csv.ts for one four-line function wasn't worth the
 * extra file.
 */
function csvField(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The same "every account, one row each" data /admin/page.tsx already
 * renders (profiles + admin_user_overview() + the Admin Auth API's
 * last-sign-in/confirmation fields — see that page's own doc comment for
 * why it's three sources), regenerated as CSV and saved to the same
 * private "admin-reports" bucket the retention export already uses, then
 * handed back as a short-lived signed URL. No new bucket or migration
 * needed — 0020_retention_notices.sql already created it.
 */
export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;

  const [{ data: profiles }, { data: overview }, authUsers] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, email, display_name, is_admin, created_at")
        .order("created_at", { ascending: false }),
      admin.rpc("admin_user_overview"),
      admin.auth.admin.listUsers({ perPage: 200 }),
    ]);

  const authById = new Map(
    (authUsers.data?.users ?? []).map((u) => [u.id, u]),
  );
  const overviewById = new Map(
    (
      (overview ?? []) as {
        user_id: string;
        clips: number;
        credits_left: number;
      }[]
    ).map((o) => [o.user_id, o]),
  );

  const rows = (profiles ?? []).map((p) => {
    const a = authById.get(p.id);
    const o = overviewById.get(p.id);
    return {
      email: p.email ?? a?.email ?? "",
      display_name: p.display_name ?? "",
      is_admin: p.is_admin ? "yes" : "no",
      joined_at: p.created_at,
      last_seen_at: a?.last_sign_in_at ?? "",
      confirmed: a?.email_confirmed_at ? "yes" : "no",
      clips: o?.clips ?? 0,
      // Credits are stored in cents (see admin_user_overview() in
      // 0017_admin_overview.sql) — divided out here since a spreadsheet of
      // account balances should read in dollars, not cents.
      credits_left_usd: ((o?.credits_left ?? 0) / 100).toFixed(2),
    };
  });

  const lines = [
    COLUMNS.join(","),
    ...rows.map((r) => COLUMNS.map((c) => csvField(r[c])).join(",")),
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

  return NextResponse.json({
    url: signed.signedUrl,
    rowCount: rows.length,
  });
}
