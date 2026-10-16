import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import LiveChatAdmin from "@/components/LiveChatAdmin";

export const dynamic = "force-dynamic";

/**
 * Who's on the site right now, and a way to message them.
 *
 * The page itself only gates access (same `requireAdmin` as every other
 * /admin page) and renders once; everything that actually changes over
 * time — the visitor list, the open thread — is client-side polling inside
 * LiveChatAdmin, same reasoning as lib/presence.ts.
 */
export default async function AdminLivePage() {
  await requireAdmin();

  return (
    <main className="min-h-screen bg-ink-950 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/admin"
          className="text-xs text-ink-400 transition hover:text-accent-400"
        >
          ← Users
        </Link>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">
          Live chat
        </h1>

        <div className="mt-6">
          <LiveChatAdmin />
        </div>
      </div>
    </main>
  );
}
