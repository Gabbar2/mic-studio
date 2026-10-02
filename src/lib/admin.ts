import { redirect } from "next/navigation";
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
