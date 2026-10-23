import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApi } from "@/lib/admin";
import { deleteUserClips } from "@/lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  noticeIds: z.array(z.string().uuid()).min(1).max(500),
});

/**
 * The one route in this feature that actually deletes customer media —
 * everything else (send, ready) only emails and reads. Deliberately a
 * separate manual step the admin triggers after seeing the "ready for
 * cleanup" list, rather than something a schedule runs unattended: the
 * privacy page already calls deletion "permanent and cannot be walked
 * back," and a bug in the targeting logic here would make good on that the
 * hard way for someone who never agreed to it.
 */
export async function POST(req: Request) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  // Re-fetch and re-check server-side rather than trusting the ids alone —
  // a notice that is still 'pending'/'cleaned', or whose deadline has not
  // actually passed, is refused here even if the browser somehow asked for
  // it, same reasoning as every tier/balance check in the generate route
  // never trusting the client's own idea of what it's allowed to submit.
  const { data: notices, error } = await admin
    .from("retention_notices")
    .select("id, user_id, email")
    .in("id", parsed.data.noticeIds)
    .eq("status", "sent")
    .lte("deadline", today);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results: { noticeId: string; email: string; clipsDeleted: number }[] =
    [];

  for (const notice of notices ?? []) {
    const clipsDeleted = await deleteUserClips(admin, notice.user_id);

    await admin
      .from("retention_notices")
      .update({
        status: "cleaned",
        cleaned_at: new Date().toISOString(),
        cleaned_clip_count: clipsDeleted,
      })
      .eq("id", notice.id);

    results.push({ noticeId: notice.id, email: notice.email, clipsDeleted });
  }

  const skipped = parsed.data.noticeIds.length - results.length;

  return NextResponse.json({
    cleaned: results.length,
    skipped,
    totalClipsDeleted: results.reduce((sum, r) => sum + r.clipsDeleted, 0),
    results,
  });
}
