import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { createClient } from "./supabase/server";
import { createAdminClient } from "./supabase/admin";

/**
 * Gate for every /admin page.
 *
 * Checked against `profiles.is_admin` via the service-role client, never
 * against anything the browser could claim — same reasoning as every other
 * admin-only figure in this app (provider balance, spend totals). A
 * signed-out visitor is sent to /login rather than /studio: /studio itself
 * renders fine for a signed-out visitor (that's the whole trial), so bouncing
 * there would look like the click silently did nothing.
 */
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) redirect("/studio");

  return { user, admin };
}

/**
 * Same gate as `requireAdmin`, for a route handler instead of a page.
 *
 * A route handler can't call `redirect()` for a non-admin caller the way a
 * page can — there's no navigation to redirect, just a response to send —
 * so this returns a ready-made `NextResponse` instead. Every admin-only
 * live-chat route (presence list, per-visitor thread) calls this itself
 * rather than trusting the admin page that links to it, same reasoning as
 * `requireAdmin`: never trust anything the browser could claim.
 */
export async function requireAdminApi(): Promise<
  | { ok: true; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not signed in" }, { status: 401 }),
    };
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.is_admin) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, admin };
}
