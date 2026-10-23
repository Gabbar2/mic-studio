import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sent notices whose deadline has already passed and that haven't been
 * cleaned up yet — the list the admin's "Ready for cleanup" section
 * actually renders. A notice never appears here before its deadline, no
 * matter what the admin UI does; the server, not the browser, is where that
 * boundary is enforced.
 */
export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("retention_notices")
    .select(
      "id, user_id, email, deadline, template_key, clip_count_at_send, sent_at",
    )
    .eq("status", "sent")
    .lte("deadline", today)
    .order("deadline", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ notices: data ?? [] });
}
