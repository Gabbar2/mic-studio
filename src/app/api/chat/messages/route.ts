import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().trim().min(1).max(2000) });

/**
 * The visitor's own thread with support — every message either side has
 * ever sent, oldest first, plus how many of the admin's replies are still
 * unread.
 *
 * `?markRead=true` is a separate step from the fetch itself, not a side
 * effect of every GET: the widget polls this quietly for its unread badge
 * while closed, and only wants messages marked read once the visitor has
 * actually opened the panel and seen them.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const admin = createAdminClient();
  const markRead = new URL(req.url).searchParams.get("markRead") === "true";

  if (markRead) {
    await admin
      .from("chat_messages")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("sender", "admin")
      .is("read_at", null);
  }

  const [{ data: messages, error }, { count: unreadCount }] =
    await Promise.all([
      admin
        .from("chat_messages")
        .select("id, sender, body, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(200),
      admin
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("sender", "admin")
        .is("read_at", null),
    ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    messages: messages ?? [],
    unreadCount: unreadCount ?? 0,
  });
}

/**
 * Sends a message as the visitor. Requires a session, but — same as the
 * ping route — never creates one: the widget calls `ensureSession()` (the
 * same Turnstile-gated anonymous sign-in Studio.tsx uses before a Generate
 * or an upload) right before this, so by the time this request lands one
 * already exists. A click on "Send" is as unambiguous a human action as
 * pressing Generate, so minting the account here is consistent with that
 * rule rather than an exception to it.
 */
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Message can't be empty" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("chat_messages")
    .insert({ user_id: user.id, sender: "visitor", body: parsed.data.body })
    .select("id, sender, body, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: data });
}
