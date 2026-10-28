import { createAdminClient } from "./supabase/admin";

const KEY = "element_edit_mock_mode";

/**
 * Whether the Reference Editor's per-element ✨ edit chat calls OpenAI for
 * real or returns a free, zero-cost stand-in. Backed by the generic
 * `app_settings` key/value table (see 0021_app_settings.sql) rather than an
 * env var, specifically so an admin can flip it at runtime from /admin
 * without a redeploy — this is the one switch in the whole AI-edit feature
 * that directly controls real spend, so it needed to be something a person
 * toggles deliberately, not a config file.
 *
 * Defaults to true (mock) when the row doesn't exist yet, e.g. right after
 * the migration runs but before anyone has visited /admin — a missing
 * setting should never silently mean "spend real money."
 */
export async function isMockElementEditEnabled(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", KEY)
    .maybeSingle();

  if (!data) return true;
  return data.value !== false;
}

export async function setMockElementEditEnabled(
  enabled: boolean,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("app_settings").upsert({
    key: KEY,
    value: enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}
