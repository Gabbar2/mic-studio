import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApi } from "@/lib/admin";
import { createClient } from "@/lib/supabase/server";
import { listUserClips } from "@/lib/retention";
import { retentionTemplate } from "@/lib/retentionEmailTemplates";
import { sendRetentionEmail } from "@/lib/retentionSend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(500),
  templateKey: z.string().min(1),
  // Plain "YYYY-MM-DD" rather than a full timestamp — the deadline is a
  // calendar date shown to the recipient and checked against, not a moment.
  deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Sends one retention-notice email per selected account and records the
 * outcome. Never deletes anything — see retention.ts and the cleanup route
 * for that, which only ever runs on the admin's own later confirmation.
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
  const { userIds, templateKey, deadline } = parsed.data;

  const template = retentionTemplate(templateKey);
  if (!template) {
    return NextResponse.json(
      { error: `Unknown template "${templateKey}"` },
      { status: 400 },
    );
  }

  // Who's actually running this — recorded on every notice row, same
  // reasoning as every other admin action's audit trail in this app.
  const supabase = await createClient();
  const {
    data: { user: actingAdmin },
  } = await supabase.auth.getUser();

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, email")
    .in("id", userIds);

  const emailById = new Map(
    (profiles ?? []).map((p) => [p.id as string, p.email as string | null]),
  );

  const results: {
    userId: string;
    email: string | null;
    status: "sent" | "failed" | "skipped";
    error?: string;
  }[] = [];

  for (const userId of userIds) {
    const email = emailById.get(userId);
    if (!email) {
      results.push({ userId, email: null, status: "skipped", error: "No email on file" });
      continue;
    }

    const clips = await listUserClips(admin, userId);
    const { subject, html } = template.build({
      email,
      deadline,
      clipLinks: clips.map((c) => ({ url: c.url, createdAt: c.createdAt })),
    });

    const sent = await sendRetentionEmail({ to: email, subject, html });

    await admin.from("retention_notices").insert({
      user_id: userId,
      email,
      deadline,
      template_key: templateKey,
      clip_count_at_send: clips.length,
      status: sent.ok ? "sent" : "failed",
      sent_at: sent.ok ? new Date().toISOString() : null,
      send_error: sent.ok ? null : sent.error,
      created_by: actingAdmin?.id ?? null,
    });

    results.push(
      sent.ok
        ? { userId, email, status: "sent" }
        : { userId, email, status: "failed", error: sent.error },
    );
  }

  return NextResponse.json({
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    results,
  });
}
