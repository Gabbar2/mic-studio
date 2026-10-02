import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { creditLabel } from "@/lib/pricing";

export const dynamic = "force-dynamic";

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Every account, one row each — email, activity, and how many clips they've
 * actually generated. This is the admin-only answer to "who is using this
 * and what have they made", without opening the Supabase SQL editor.
 *
 * Three sources merged by user id, because that's genuinely three different
 * places this data lives: `profiles` (email, admin flag — public schema,
 * readable via the service-role client), `auth.users` (last sign-in, email
 * confirmation — not exposed over PostgREST at all, so it comes from the
 * Admin Auth API instead), and `admin_user_overview()` (clip count and
 * credit balance, aggregated in Postgres rather than pulling every ledger
 * and generation row across every user into this request).
 */
export default async function AdminUsersPage() {
  const { admin } = await requireAdmin();

  const [{ data: profiles }, { data: overview }, authUsers] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, email, display_name, is_admin, created_at")
        .order("created_at", { ascending: false }),
      admin.rpc("admin_user_overview"),
      // Up to 200 accounts on one page. Fine for now — this is an internal
      // tool, not a customer-facing list, and pagination can be added the
      // day that limit actually bites.
      admin.auth.admin.listUsers({ perPage: 200 }),
    ]);

  const authById = new Map(
    (authUsers.data?.users ?? []).map((u) => [u.id, u]),
  );
  const overviewById = new Map(
    ((overview ?? []) as {
      user_id: string;
      clips: number;
      credits_left: number;
    }[]).map((o) => [o.user_id, o]),
  );

  const rows = (profiles ?? []).map((p) => {
    const a = authById.get(p.id);
    const o = overviewById.get(p.id);
    return {
      id: p.id,
      email: p.email ?? a?.email ?? "—",
      displayName: p.display_name,
      isAdmin: p.is_admin,
      joinedAt: p.created_at,
      lastSeenAt: a?.last_sign_in_at ?? null,
      confirmed: !!a?.email_confirmed_at,
      clips: o?.clips ?? 0,
      creditsLeftCents: o?.credits_left ?? 0,
    };
  });

  return (
    <main className="min-h-screen bg-ink-950 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/studio"
          className="text-xs text-ink-400 transition hover:text-accent-400"
        >
          ← Mic Studio
        </Link>

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Users
          </h1>
          <span className="text-xs tabular-nums text-ink-400">
            {rows.length} accounts
          </span>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border border-ink-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink-800 bg-ink-900/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Email
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Joined
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Last seen
                </th>
                <th className="px-3 py-2.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Confirmed
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Clips
                </th>
                <th className="px-3 py-2.5 text-right text-[11px] font-medium uppercase tracking-wide text-ink-400">
                  Credits
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-ink-800/70 last:border-0 hover:bg-ink-900/40"
                >
                  <td className="px-3 py-2.5 text-ink-200">
                    {r.email}
                    {r.isAdmin && (
                      <span className="ml-2 rounded border border-accent-500/40 bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-400">
                        Admin
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-400">
                    {fmt(r.joinedAt)}
                  </td>
                  <td className="px-3 py-2.5 text-ink-400">
                    {fmt(r.lastSeenAt)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {r.confirmed ? (
                      <span className="text-accent-400">✓</span>
                    ) : (
                      <span className="text-ink-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-200">
                    {r.clips}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-200">
                    {creditLabel(r.creditsLeftCents)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Link
                      href={`/admin/users/${r.id}`}
                      className="text-xs text-accent-400 underline underline-offset-2 transition hover:text-white"
                    >
                      View clips
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
