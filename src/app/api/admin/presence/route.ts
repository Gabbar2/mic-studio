import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin";
import { bulkUnlockedUserIds } from "@/lib/credits";
import { ONLINE_WINDOW_SECONDS, type LiveVisitor } from "@/lib/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everyone who has pinged within the online window, most-recently-active
 * first, each tagged with the same three-tier split used everywhere else
 * in this app (trial / free / unlocked) and how many of their messages are
 * still unread.
 *
 * Trial is read straight off the denormalized `is_anonymous` column
 * `visitor_presence` already carries — no auth lookup needed. Free vs.
 * unlocked is the one check that can't be denormalized onto a presence
 * ping (it can change between pings without the visitor doing anything
 * presence-related, e.g. a webhook landing a purchase), so it's done here,
 * batched across every currently-online non-anonymous visitor in one pair
 * of queries rather than one pair per row.
 */
export async function GET() {
  const gate = await requireAdminApi();
  if (!gate.ok) return gate.response;
  const { admin } = gate;

  const since = new Date(
    Date.now() - ONLINE_WINDOW_SECONDS * 1000,
  ).toISOString();

  const [{ data: presence, error }, { data: unread }] = await Promise.all([
    admin
      .from("visitor_presence")
      .select("user_id, email, is_anonymous, path, last_seen_at")
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false }),
    admin.rpc("admin_chat_unread_counts"),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = presence ?? [];
  const unreadById = new Map(
    ((unread ?? []) as { user_id: string; unread_count: number }[]).map(
      (u) => [u.user_id, u.unread_count],
    ),
  );

  const nonAnonIds = rows
    .filter((r) => !r.is_anonymous)
    .map((r) => r.user_id);
  const unlockedIds = await bulkUnlockedUserIds(nonAnonIds);

  const visitors: LiveVisitor[] = rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    tier: r.is_anonymous
      ? "trial"
      : unlockedIds.has(r.user_id)
        ? "unlocked"
        : "free",
    path: r.path,
    lastSeenAt: r.last_seen_at,
    unreadCount: unreadById.get(r.user_id) ?? 0,
  }));

  return NextResponse.json({ visitors });
}
