import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeProvider } from "@/lib/providers";
import {
  creditLiabilityCents,
  liabilityAsProviderCents,
} from "@/lib/appState";
import {
  chargeForProviderCost,
  creditBalance,
  ensureSignupGrant,
  isUnlockedAccount,
  priceMarkup,
  CREDIT_PACKS,
  SUBSCRIPTION_PLANS,
} from "@/lib/credits";
import { anonGrantCents } from "@/lib/anon";
import type { AccountTier } from "@/lib/freeTier";
import { estimateCostCents, KLING_V3 } from "@/lib/models";
import Studio from "@/components/Studio";
import type { Generation } from "@/lib/types";

export const dynamic = "force-dynamic";

// The two benchmark numbers shown in the reference-mode credit notice: what a
// plain 10-second Pro or 4K clip costs, silent, on the standard text2video
// rate. Reference mode's own rate is different (and has no 4K tier at all),
// so these are deliberately not "what reference mode costs" — they're the
// two prices a signed-in visitor can already picture, used as a gut-check on
// "do I have enough credits" before committing to a reference job.
const REFERENCE_NOTICE_DURATION_SECONDS = 10;
function referenceBenchmarkCents(quality: "pro" | "4k"): number {
  return chargeForProviderCost(
    estimateCostCents(
      KLING_V3,
      "text2video",
      quality,
      REFERENCE_NOTICE_DURATION_SECONDS,
      false,
      false,
    ),
  );
}

export default async function StudioPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A signed-out visitor gets the studio in trial state: the composer works,
  // the gallery is empty, and the first Generate is what creates their
  // anonymous account.
  if (!user) {
    return (
      <Studio
        initialGenerations={[]}
        email=""
        displayName="you"
        dailyQuota={1}
        usedToday={0}
        initialSpend={{ todayCents: 0, totalCents: 0 }}
        initialBalance={null}
        initialCoverageCents={null}
        initialCreditCents={
          // Cents, as the name says — NOT credits. creditLabel() applies
          // CREDITS_PER_CENT itself when it renders, so multiplying here too
          // showed a signed-out visitor 7,500 credits against a 750-credit
          // clip: ten free clips promised, one delivered.
          anonGrantCents()
        }
        priceMarkup={priceMarkup()}
        packs={CREDIT_PACKS}
        plans={SUBSCRIPTION_PLANS}
        subscription={null}
        isAdmin={false}
        isTrial
        tier="trial"
        signedIn={false}
      />
    );
  }

  const admin = createAdminClient();

  const isAnonymous = user.is_anonymous === true;

  // Lazy first-run grant, so a new account has something to try with.
  // The email/firstName here (not the profile row, which isn't fetched
  // until the Promise.all below) are what the "first_login" welcome email
  // is addressed to.
  await ensureSignupGrant(
    user.id,
    isAnonymous,
    user.email ? { email: user.email } : undefined,
  );

  const [
    { data: generations },
    { data: profile },
    { data: usedToday },
    { data: spendRows },
    balance,
    creditCents,
    liabilityCents,
    { data: subscriptionRow },
    unlocked,
  ] = await Promise.all([
      admin
        .from("generations")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50),
      admin
        .from("profiles")
        .select("daily_quota, display_name, is_admin")
        .eq("id", user.id)
        .maybeSingle(),
      admin.rpc("generations_today", { p_user: user.id }),
      admin.rpc("spend_summary", { p_user: user.id }),
      // Never let a provider outage block the studio from rendering.
      activeProvider().getBalance?.().catch(() => null) ?? null,
      creditBalance(user.id),
      // What customers could still spend. Cheap (one sum over the ledger) and
      // only meaningful to the operator, so it is discarded below for
      // everyone else rather than being fetched conditionally.
      creditLiabilityCents().catch(() => 0),
      // Most recent subscription row, whatever its status — a canceled one
      // still needs to render so the account menu can offer "resubscribe"
      // instead of silently looking like this user never had a plan.
      admin
        .from("subscriptions")
        .select("plan_id, status, current_period_end, cancel_at_period_end")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // Whether this account has ever paid — subscription or one-time pack —
      // which is what separates the capped "free" tier from a fully
      // unlocked one. See lib/credits.ts's isUnlockedAccount.
      isAnonymous ? false : isUnlockedAccount(user.id),
    ]);

  const spendRow = Array.isArray(spendRows) ? spendRows[0] : spendRows;
  const tier: AccountTier = isAnonymous
    ? "trial"
    : unlocked
      ? "unlocked"
      : "free";

  return (
    <Studio
      initialGenerations={(generations ?? []) as Generation[]}
      email={user.email ?? ""}
      displayName={profile?.display_name ?? user.email?.split("@")[0] ?? "you"}
      dailyQuota={profile?.daily_quota ?? 5}
      usedToday={usedToday ?? 0}
      initialSpend={{
        todayCents: spendRow?.today_cents ?? 0,
        totalCents: spendRow?.total_cents ?? 0,
      }}
      // The provider's own balance is the operator's business, not every
      // signed-in user's — it only renders for admins.
      initialBalance={profile?.is_admin ? (balance?.balance ?? null) : null}
      initialCoverageCents={
        profile?.is_admin
          ? liabilityAsProviderCents(liabilityCents, priceMarkup())
          : null
      }
      initialCreditCents={creditCents}
      priceMarkup={priceMarkup()}
      packs={CREDIT_PACKS}
      plans={SUBSCRIPTION_PLANS}
      subscription={subscriptionRow ?? null}
      isAdmin={!!profile?.is_admin}
      isTrial={isAnonymous}
      tier={tier}
      referenceProCents={referenceBenchmarkCents("pro")}
      referenceFourKCents={referenceBenchmarkCents("4k")}
      // A session exists, even when there is no email on it. Studio needs this
      // to know not to call signInAnonymously a second time.
      signedIn
    />
  );
}
