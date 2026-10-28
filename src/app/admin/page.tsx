import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import UsersTable from "@/components/admin/UsersTable";
import RetentionCleanupPanel from "@/components/admin/RetentionCleanupPanel";
import ElementEditSettingsPanel from "@/components/admin/ElementEditSettingsPanel";

export const dynamic = "force-dynamic";

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
        <div className="flex items-baseline justify-between">
          <Link
            href="/studio"
            className="text-xs text-ink-400 transition hover:text-accent-400"
          >
            ← Mic Studio
          </Link>
          {/* Live chat is now tawk.to — reply from dashboard.tawk.to or
              their mobile apps, not from here. See TawkToWidget.tsx. */}
          <a
            href="https://dashboard.tawk.to/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-400 transition hover:text-accent-400"
          >
            Live chat (tawk.to) ↗
          </a>
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Users
          </h1>
          <span className="text-xs tabular-nums text-ink-400">
            {rows.length} accounts
          </span>
        </div>

        <div className="mt-6">
          <UsersTable rows={rows} />
        </div>

        <RetentionCleanupPanel />
        <ElementEditSettingsPanel />
      </div>
    </main>
  );
}
