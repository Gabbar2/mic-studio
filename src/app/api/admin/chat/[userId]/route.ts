import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminApi } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ body: z.string().trim().min(1).max(2000) });

/**
 * One visitor's thread, from the admin side. Fetching it marks every unread
 * visitor message as read — opening the thread is the admin's "seen it",
 * same idea as the visitor side marking admin messages read on `markRead`.
 *
 * Works even once the visitor has gone offline (no presence row left, or a
 * stale one) — this only touches chat_messages, which outlives presence by
 * design. The admin can keep replying to someone who stepped away; they'll
 * see it next time they're back.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;
  const { userId } = await params;

  await admin
    .from("chat_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("sender", "visitor")
    .is("read_at", null);

  const { data: messages, error } = await admin
    .from("chat_messages")
    .select("id, sender, body, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ messages: messages ?? [] });
}

/** Sends a message as support, into this one visitor's thread. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;
  const { userId } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Message can't be empty" },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from("chat_messages")
    .insert({ user_id: userId, sender: "admin", body: parsed.data.body })
    .select("id, sender, body, created_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: data });
}
