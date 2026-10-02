import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const Body = z.object({ path: z.string().max(300).default("/") });

/**
 * Heartbeat from the live chat widget — "this visitor is still here, on
 * this page". Upserts the same row every time (one per user_id), since this
 * is presence, not history; chat_messages is where history lives.
 *
 * 401s for a visitor with no session at all, same as every other endpoint
 * here — the widget only calls this once a session already exists (signed
 * in, or already anonymous from generating a trial clip or sending a chat
 * message). It never creates one itself, which matters: this app
 * deliberately only mints an anonymous account on an unambiguous human
 * action (see Studio.tsx's ensureSession), specifically so a crawler
 * loading every page doesn't turn into a row in auth.users. A presence
 * ping firing on every page load for everyone, signed in or not, would
 * quietly reopen exactly that hole.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const path = parsed.success ? parsed.data.path : "/";

  const admin = createAdminClient();
  const { error } = await admin.from("visitor_presence").upsert({
    user_id: user.id,
    email: user.email ?? null,
    is_anonymous: user.is_anonymous === true,
    path,
    last_seen_at: new Date().toISOString(),
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
