import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. Bypasses RLS — never import this into anything that
 * ships to the browser. All generation writes go through here so the client
 * can't forge job rows.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");

  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
