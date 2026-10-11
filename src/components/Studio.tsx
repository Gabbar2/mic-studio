"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import Composer, { type ComposerValue } from "./Composer";
import GenerationGrid from "./GenerationGrid";
import StudioHeader from "./StudioHeader";
import VideoModal from "./VideoModal";
import ThumbnailBackfill from "./ThumbnailBackfill";
import TopUp from "./TopUp";
import ProjectCost from "./ProjectCost";
import { useTurnstile } from "./useTurnstile";
import SignInPrompt from "./SignInPrompt";
import UpgradePrompt from "./UpgradePrompt";
import {
  lockForErrorCode,
  type TrialLock,
  type UpgradeLock,
} from "@/lib/trialLocks";
import type { AccountTier } from "@/lib/freeTier";
import { setSessionEnsurer } from "@/lib/upload";
import { DEFAULT_MODEL_ID, MODELS } from "@/lib/models";
import type { Generation } from "@/lib/types";
import type { Spend } from "@/lib/format";
import type { UpscaleTarget } from "@/lib/upscale";

const POLL_MS = 5000;

export default function Studio({
  initialGenerations,
  email,
  displayName,
  dailyQuota,
  usedToday,
  initialSpend,
  initialBalance,
  initialCoverageCents,
  initialCreditCents,
  priceMarkup,
  packs,
  plans,
  subscription,
  isAdmin = false,
  isTrial = false,
  tier,
  signedIn = false,
  referenceProCents,
  referenceFourKCents,
}: {
  initialGenerations: Generation[];
  email: string;
  displayName: string;
  dailyQuota: number;
  usedToday: number;
  initialSpend: Spend;
  initialBalance: number | null;
  initialCoverageCents: number | null;
  initialCreditCents: number;
  priceMarkup: number;
  packs: readonly {
    id: string;
    priceCents: number;
    creditCents: number;
    label: string;
  }[];
  plans: readonly {
    id: string;
    interval: string;
    priceCents: number;
    creditCents: number;
    label: string;
  }[];
  /** Most recent subscription row for this account, whatever its status. */
  subscription: {
    plan_id: string | null;
    status: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
  isAdmin?: boolean;
  /**
   * A visitor who has not signed in, or an anonymous account mid-trial. Both
   * see the same restricted composer and the same "save this clip" prompt.
   */
  isTrial?: boolean;
  /**
   * The full three-way tier — see Composer's own doc comment. Optional so
   * this component still works if a caller only ever passes `isTrial`;
   * derived from it when omitted (`isTrial ? "trial" : "unlocked"`), which
   * matches this app's behavior before the free tier existed.
   */
  tier?: AccountTier;
  /**
   * Whether a session exists at all — true for an anonymous account as well as
   * a real one.
   *
   * This cannot be derived from `email`, and that distinction is the whole
   * point of the prop. An anonymous user has no email, so `!email` is true both
   * before their first clip and after it. Keying the sign-in call off `email`
   * meant the second Generate called `signInAnonymously` again, which does not
   * return the existing session — it mints a *new* anonymous user, with a new
   * welcome grant. The one-clip trial would have been defeated by pressing the
   * button twice.
   */
  signedIn?: boolean;
  /** Passed straight through to Composer's reference-mode credit notice. */
  referenceProCents?: number;
  referenceFourKCents?: number;
}) {
  const router = useRouter();
  // Only ever used on the anonymous path, but the widget has to be mounted
  // before the click that needs it — a challenge started on submit would add
  // its whole solve time to the visitor's first Generate.
  const { getToken, Widget } = useTurnstile();
  const [generations, setGenerations] =
    useState<Generation[]>(initialGenerations);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Generation | null>(null);
  const [used, setUsed] = useState(usedToday);
  const [spend, setSpend] = useState<Spend>(initialSpend);
  const [balance, setBalance] = useState<number | null>(initialBalance);
  const [credit, setCredit] = useState(initialCreditCents);
  /** Which trial limit was just reached, if any. Drives the sign-in modal. */
  const [lock, setLock] = useState<TrialLock | null>(null);
  /** Which free-tier cap was just reached, if any. Drives the upgrade modal. */
  const [upgradeLock, setUpgradeLock] = useState<UpgradeLock | null>(null);
  const resolvedTier: AccountTier = tier ?? (isTrial ? "trial" : "unlocked");
  /** De-duplicates concurrent anonymous sign-ins. See ensureSession. */
  const anonInFlight = useRef<Promise<boolean> | null>(null);

  const [value, setValue] = useState<ComposerValue>({
    modelId: DEFAULT_MODEL_ID,
    mode: "text2video",
    prompt: "",
    negativePrompt: "",
    aspectRatio: "16:9",
    durationSeconds: 5,
    quality: "std",
    cfgScale: 0.5,
    // The free clip is silent, so a trial visitor must not start with audio
    // selected — the server would refuse it.
    withAudio: !isTrial,
    imageUrl: "",
    endImageUrl: "",
    referenceVideoUrl: "",
    referenceImageUrls: [],
  });

  // Upscales are polled through the same endpoint, so a running upscale has to
  // keep the poll alive too — otherwise it finishes and the UI never notices.
  const inFlight = generations.some(
    (g) =>
      g.status === "queued" ||
      g.status === "processing" ||
      g.upscale_status === "queued" ||
      g.upscale_status === "processing",
  );

  /**
   * Creates the anonymous account, once, on the first action that needs one.
   *
   * Deliberately not on page load — that would turn every crawler into a row
   * in auth.users, which is the abuse Supabase warns about. Both callers are
   * unambiguous human actions: pressing Generate, or dropping in an image.
   */
  const ensureSession = useCallback(async () => {
    if (signedIn) return true;

    // Two guards, and both are load-bearing.
    //
    // The `signedIn` prop above comes from the server render, so it is stale
    // the instant this function creates an account — it stays false until
    // router.refresh() lands. Asking the client for the real session is what
    // stops a second upload from minting a second anonymous user with a
    // second welcome grant.
    //
    // And the in-flight promise stops two simultaneous uploads from racing
    // into two signInAnonymously calls, which does the same damage in a
    // narrower window. Dropping a start frame and an end frame together is
    // exactly that case.
    if (anonInFlight.current) return anonInFlight.current;

    const run = (async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (session) return true;

      const captchaToken = await getToken();
      const { error: anonError } = await supabase.auth.signInAnonymously({
        options: { captchaToken },
      });
      return !anonError;
    })();

    anonInFlight.current = run;
    try {
      return await run;
    } finally {
      anonInFlight.current = null;
    }
  }, [signedIn, getToken]);

  // Uploads happen deep inside MediaDrop and ReferencePanel, neither of which
  // knows anything about auth. Registering the ensurer here lets uploadMedia
  // create the account on demand without threading a callback through three
  // components that have no other reason to care.
  useEffect(() => {
    setSessionEnsurer(ensureSession);
    return () => setSessionEnsurer(null);
  }, [ensureSession]);

  const handleUpscale = useCallback(
    async (id: string, target: UpscaleTarget) => {
      const res = await fetch("/api/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId: id, target }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Could not start the upscale.");
      }
      setGenerations((prev) =>
        prev.map((g) => (g.id === id ? (json.generation as Generation) : g)),
      );
    },
    [],
  );

  const refreshBalance = useCallback(async () => {
    try {
      const res = await fetch("/api/balance", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setBalance(typeof json.balance === "number" ? json.balance : null);
    } catch {
      // leave the last known value in place
    }
  }, []);

  const refreshCredit = useCallback(async () => {
    try {
      const res = await fetch("/api/credits", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      if (typeof json.balanceCents === "number") setCredit(json.balanceCents);
    } catch {
      // keep the last known figure
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/generations", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setGenerations(json.generations as Generation[]);
      if (json.spend) setSpend(json.spend as Spend);
      // Admin-only figure, so admin-only request. Every non-admin used to
      // poll fal every five seconds for a number their header never renders,
      // which was roughly half of all provider API calls.
      if (isAdmin) void refreshBalance();
      void refreshCredit();
    } catch {
      // transient — the next tick will retry
    }
  }, [isAdmin, refreshBalance, refreshCredit]);

  // Poll only while something is actually rendering. An idle tab makes no
  // requests, which matters because each poll also hits the provider's API
  // (Kling or Wan, whichever ran the job).
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refresh]);

  const handleThumbnail = useCallback((id: string, url: string) => {
    setGenerations((prev) =>
      prev.map((g) => (g.id === id ? { ...g, thumbnail_url: url } : g)),
    );
  }, []);

  async function submit() {
    if (!value.prompt.trim() || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      // The anonymous account is created here and nowhere else. Doing it on
      // page load would turn every crawler into a row in auth.users, which is
      // the abuse Supabase warns about; doing it here means an account exists
      // only for someone who actually asked for a clip.
      if (!signedIn && !(await ensureSession())) {
        setError("Could not start your free clip. Please refresh and try again.");
        return;
      }

      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: value.modelId,
          mode: value.mode,
          prompt: value.prompt.trim(),
          negativePrompt: value.negativePrompt.trim() || undefined,
          aspectRatio: value.aspectRatio,
          durationSeconds: value.durationSeconds,
          quality: value.quality,
          cfgScale: value.cfgScale,
          withAudio: value.withAudio,
          imageUrl:
            value.mode !== "text2video" && value.imageUrl
              ? value.imageUrl
              : undefined,
          endImageUrl:
            value.mode !== "text2video" && value.endImageUrl
              ? value.endImageUrl
              : undefined,
          referenceVideoUrl:
            value.mode === "reference2video" && value.referenceVideoUrl
              ? value.referenceVideoUrl
              : undefined,
          referenceImageUrls:
            value.mode === "reference2video"
              ? value.referenceImageUrls
              : undefined,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        // A trial limit or a free-tier cap is an invitation, not an error.
        // Open the matching ask rather than printing red text the visitor can
        // do nothing about.
        const hit = isTrial ? lockForErrorCode(json.code) : null;
        if (hit) {
          setLock(hit);
        } else if (json.code === "tier_locked" && json.lock) {
          setUpgradeLock(json.lock as UpgradeLock);
        } else {
          setError(json.error ?? "Something went wrong");
        }
        return;
      }

      setGenerations((prev) => [json.generation as Generation, ...prev]);
      setUsed((n) => n + 1);
      // The first trial clip changes who the server thinks we are, so the page
      // has to re-render to pick up the real balance and history.
      if (!signedIn) router.refresh();
      if (isAdmin) void refreshBalance();
      void refreshCredit();
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const model = MODELS.find((m) => m.id === value.modelId)!;
  const remaining = Math.max(0, dailyQuota - used);

  return (
    <div className="flex h-screen flex-col bg-ink-950">
      <StudioHeader
        modelLabel={model.label}
        email={email}
        displayName={displayName}
        dailyQuota={dailyQuota}
        usedToday={used}
        spend={spend}
        balance={balance}
        coverageCents={initialCoverageCents}
        creditCents={credit}
        isAdmin={isAdmin}
        spendSlot={
          <ProjectCost
            todayCents={spend.todayCents}
            totalCents={spend.totalCents}
          />
        }
        accountExtra={
          <>
            {isAdmin && (
              <Link
                href="/admin"
                className="mb-3 block rounded-lg border border-ink-700 px-3 py-1.5 text-center text-xs text-ink-200 transition hover:border-accent-500 hover:text-accent-400"
              >
                Admin — users &amp; clips
              </Link>
            )}
            <TopUp
              balanceCents={credit}
              packs={packs}
              plans={plans}
              subscription={subscription}
              isAdmin={isAdmin}
            />
          </>
        }
      />

      {/* Stacks below md so the composer is a block above the gallery rather
          than a 340px column squeezed into a phone. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {/* The composer panel.

            The fill is a neutral vertical gradient, not a lime one. Every
            field in here sits at ink-850, and any lime wash strong enough to
            see pushes the panel ground past that value — at which point the
            inputs stop reading as raised and start reading as holes. Same
            trap the login field fell into. So the panel gets depth from the
            gradient and its colour from the edge light instead. */}
        <aside
          className="relative isolate shrink-0 border-b border-ink-800 p-4 md:w-[340px] md:overflow-y-auto md:border-b-0 md:p-5"
          style={{
            // Neutral depth stays static — only the lime wash below drifts.
            backgroundImage:
              "linear-gradient(180deg, #0d100c 0%, #0d100c 55%, #080a07 100%)",
          }}
        >
          {/* The lime portion of the panel's old two-layer background, split
              out so it can drift in hue without dragging the neutral gradient
              (and therefore the panel's whole depth) along with it.
              `-z-10` + the parent's `isolate` keeps it pinned behind the
              composer fields, contained to this panel only. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 hue-drift"
            style={{
              background:
                "radial-gradient(120% 40% at 50% 100%, rgba(164,212,24,0.34), transparent 75%)",
            }}
          />

          <Composer
            value={value}
            onChange={setValue}
            onSubmit={submit}
            submitting={submitting}
            disabled={remaining === 0}
            error={error}
            priceMarkup={priceMarkup}
            creditCents={credit}
            isAdmin={isAdmin}
            tier={resolvedTier}
            onLocked={(l) =>
              resolvedTier === "free"
                ? setUpgradeLock(l as UpgradeLock)
                : setLock(l)
            }
            referenceProCents={referenceProCents}
            referenceFourKCents={referenceFourKCents}
          />

          {/* Mounted only where an auth call can still happen. For a signed-in
              account there is nothing left to challenge, and an idle widget
              still phones Cloudflare on every page load. */}
          {!signedIn && (
            <div className="mt-3">
              <Widget />
            </div>
          )}
        </aside>

        {/* Edge light, replacing the flat md:border-r. Lime at the top fading
            to neutral, so the panel is lit from the same direction as the
            cards. It lives out here rather than inside the aside because the
            aside scrolls — an absolute child in there would stretch to the
            full scroll height and drag the bright end off-screen. This parent
            is overflow-hidden at md, so the strip stays put.

            left-[340px] is the aside's md width; the two move together. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-[340px] hidden w-px md:block hue-drift"
          style={{
            background:
              "linear-gradient(180deg, rgba(198,248,44,0.8) 0%, rgba(198,248,44,0.28) 24%, rgba(34,39,29,0.95) 58%)",
          }}
        />

        {/* The ground the cards sit on. A wash of lime bleeding down from the
            top, not a full gradient — the clips themselves are the colour on
            this side of the screen and a strong gradient competes with them.
            Default background-attachment keeps it pinned while the grid
            scrolls, so it reads as light in the room rather than wallpaper. */}
        <main className="relative isolate min-h-0 flex-1 p-4 md:overflow-y-auto md:p-6">
          {/* Same split as the composer panel: the wash drifts, the actual
              clip grid never does. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 hue-drift"
            style={{
              // Centered at the panel's own top edge (0%, not -8%) and
              // brighter still (0.4) than the first visibility fix (0.22) —
              // that pass fixed the positioning but the wash was still too
              // faint against the panel's own dark ground to read as moving
              // colour rather than a static glow.
              background:
                "radial-gradient(140% 65% at 50% 0%, rgba(164,212,24,0.4), transparent 70%)",
            }}
          />

          <GenerationGrid
            generations={generations}
            onOpen={(g) => setOpen(g)}
            onUpscale={handleUpscale}
            isAdmin={isAdmin}
            isTrial={isTrial}
            onReuse={(g) =>
              setValue((v) => ({
                ...v,
                mode: g.mode,
                prompt: g.prompt,
                negativePrompt: g.negative_prompt ?? "",
                imageUrl: g.source_image_url ?? "",
                endImageUrl: g.end_image_url ?? "",
                referenceVideoUrl: g.reference_video_url ?? "",
                referenceImageUrls: g.reference_image_urls ?? [],
                aspectRatio: g.aspect_ratio,
                durationSeconds: g.duration_seconds,
                quality: g.quality,
              }))
            }
          />
        </main>
      </div>

      <ThumbnailBackfill
        generations={generations}
        onThumbnail={handleThumbnail}
      />

      {open && <VideoModal generation={open} onClose={() => setOpen(null)} />}

      {lock && (
        <SignInPrompt
          lock={lock}
          signedIn={signedIn}
          getCaptchaToken={getToken}
          onClose={() => setLock(null)}
        />
      )}

      {upgradeLock && (
        <UpgradePrompt
          lock={upgradeLock}
          onClose={() => setUpgradeLock(null)}
          creditCents={credit}
          priceMarkup={priceMarkup}
          modelId={value.modelId}
          mode={value.mode}
          withAudio={value.withAudio}
        />
      )}
    </div>
  );
}
