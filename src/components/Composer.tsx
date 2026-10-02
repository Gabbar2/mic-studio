"use client";

import { useState } from "react";
import MediaDrop from "./MediaDrop";
import ReferencePanel from "./ReferencePanel";
import ConsentCheckbox, { UploadConsentProvider } from "./UploadConsent";
import {
  durationsFor,
  effectiveMarkup,
  estimateCostCents,
  MODE_LABEL,
  MODELS,
  qualitiesFor,
  QUALITY_LABEL,
  resolutionFor,
  type AspectRatio,
  type GenerationMode,
  type Quality,
} from "@/lib/models";
import { creditLabel, roundChargeCents } from "@/lib/pricing";
import {
  TRIAL_DURATION_SECONDS,
  TRIAL_MODE,
  TRIAL_MODEL_ID,
  TRIAL_QUALITY,
} from "@/lib/anon";
import { FREE_DURATIONS, FREE_MODES, FREE_QUALITY, type AccountTier } from "@/lib/freeTier";
import type { TrialLock } from "@/lib/trialLocks";

export interface ComposerValue {
  modelId: string;
  mode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  aspectRatio: AspectRatio;
  durationSeconds: number;
  quality: Quality;
  cfgScale: number;
  withAudio: boolean;
  imageUrl: string;
  endImageUrl: string;
  referenceVideoUrl: string;
  referenceImageUrls: string[];
}

const RATIO_LABEL: Record<AspectRatio, string> = {
  "16:9": "Landscape",
  "9:16": "Vertical",
  "1:1": "Square",
};

export default function Composer({
  value,
  onChange,
  onSubmit,
  submitting,
  disabled,
  error,
  priceMarkup = 1,
  creditCents,
  isAdmin = false,
  tier = "unlocked",
  onLocked,
  referenceProCents,
  referenceFourKCents,
}: {
  value: ComposerValue;
  onChange: (v: ComposerValue) => void;
  onSubmit: () => void;
  submitting: boolean;
  disabled: boolean;
  error: string | null;
  /**
   * Both optional so this component works before AND after the credits patch.
   * With no creditCents supplied there is no billing yet: nothing is gated on
   * balance and the footer quotes the operator's provider cost instead of a
   * customer price.
   */
  priceMarkup?: number;
  creditCents?: number;
  /** Only the operator sees dollars, provider cost and margin. */
  isAdmin?: boolean;
  /**
   * Three tiers, three shapes:
   *  - `trial`: text-to-video, Standard, 5 seconds, silent — the anonymous
   *    free clip.
   *  - `free`: a real signed-up account with no subscription or purchase
   *    yet. Standard quality, 5 or 10 second clips, text-to-video or
   *    image-to-video, audio allowed — Pro/4K, 15s, and reference-to-video
   *    are held back.
   *  - `unlocked`: a subscriber or anyone who has bought credits. No hard
   *    caps — just the credit floor everyone eventually hits.
   * Whatever a tier does not include is rendered locked rather than hidden,
   * and the footer says why.
   */
  tier?: AccountTier;
  /**
   * Called instead of changing the value when a trial or free-tier account
   * reaches for something their tier does not include. The value
   * deliberately does not change — the server would refuse it, and a control
   * that visibly moves and then fails is worse than one that opens the ask.
   */
  onLocked?: (lock: TrialLock) => void;
  /**
   * Benchmark prices (in cents, already through the same markup/rounding as
   * every other figure here) shown in the reference-mode credit notice below
   * — in credits, "a 10s Pro clip" and "a 10s 4K clip" are what a signed-in
   * visitor already understands, and reference mode's own rate isn't
   * something they've seen yet. Omit either (or both) to leave that line out.
   */
  referenceProCents?: number;
  referenceFourKCents?: number;
}) {
  const [showReferenceCreditNotice, setShowReferenceCreditNotice] =
    useState(false);

  const isTrial = tier === "trial";
  const isFree = tier === "free";

  const model = MODELS.find((m) => m.id === value.modelId)!;
  const set = <K extends keyof ComposerValue>(k: K, v: ComposerValue[K]) =>
    onChange({ ...value, [k]: v });

  const isReference = value.mode === "reference2video";
  // Start/end frame fields are Kling-O3-specific (shot_type: "customize" with
  // start_image_url/end_image_url) — Wan's reference endpoints have no such
  // fields, so showing them there would be controls that quietly do nothing.
  const usesFrames =
    value.mode === "image2video" || (isReference && !!model.supportsReferenceVideo);

  const cost = estimateCostCents(
    model,
    value.mode,
    value.quality,
    value.durationSeconds,
    value.withAudio && model.supportsAudio,
    !!value.referenceVideoUrl,
  );
  // What the user actually pays. The provider figure is the operator's cost,
  // not the price on the button.
  //
  // This MUST be roundChargeCents and not a plain multiply. The server debits
  // via chargeForProviderCost, which rounds to a 50-credit multiple; quoting
  // the unrounded figure here made the button and the ledger disagree by up to
  // 20 credits, and on Standard 5s with audio it quoted 1,140 and charged
  // 1,150 — the customer paying more than the price they clicked.
  const billingEnabled = creditCents != null;
  // A model with its own priceMarkupOverride (see lib/models.ts — Wan runs a
  // steeper markup than Kling since its provider cost is so much lower) is
  // priced on that curve instead of the operator's blanket `priceMarkup`.
  const price = roundChargeCents(cost * effectiveMarkup(model, priceMarkup));
  const affordable = !billingEnabled || creditCents >= price;

  const overLimit = value.prompt.length > model.maxPromptChars;
  const needsImage = value.mode === "image2video" && !value.imageUrl.trim();
  const needsReference =
    isReference && !value.referenceVideoUrl && !value.referenceImageUrls.length;

  // A reference video defines the frame — Kling inherits its shape and the
  // aspect_ratio parameter does not override it.
  const ratioFollowsSource = isReference && !!value.referenceVideoUrl;

  // O1 video-to-video has no tier in its path. Once a reference video is
  // attached, Standard/Pro change nothing about the output and the job bills
  // one flat rate either way — so the control has to say so rather than sit
  // there looking meaningful.
  const tierIgnored = ratioFollowsSource;

  // Says whether anything non-default is hiding inside the folded group — a
  // collapsed section that silently changes your output is a trap.
  const advancedTouched =
    value.negativePrompt.trim().length > 0 || value.cfgScale !== 0.5;

  return (
    <div className="space-y-5">
      {/* model — locked to Kling on the trial, same reasoning as mode below:
          the 75-cent grant is sized to exactly one Kling std-5s-silent clip,
          and a cheaper model would quietly turn that into several free clips. */}
      <Field label="Model">
        <SegmentedControl
          options={MODELS.map((m) => ({
            value: m.id,
            label: m.label,
            locked: isTrial && m.id !== TRIAL_MODEL_ID,
          }))}
          value={value.modelId}
          onLocked={() => onLocked?.("model")}
          onChange={(id) => {
            const next = MODELS.find((m) => m.id === id);
            if (!next) return;
            // Switching models can leave the current mode/quality/duration
            // outside what the new model offers (Wan 2.2 has no reference
            // mode at all, Wan 2.7's reference endpoint caps at 10s, nobody
            // but Kling has 4K) — fall back to something it actually
            // supports rather than send a shape the provider will reject.
            const mode = next.modes.includes(value.mode)
              ? value.mode
              : next.modes[0];
            const quality = qualitiesFor(next, mode).includes(value.quality)
              ? value.quality
              : qualitiesFor(next, mode)[0];
            const durationSeconds = durationsFor(next, mode).includes(
              value.durationSeconds,
            )
              ? value.durationSeconds
              : durationsFor(next, mode)[0];
            onChange({
              ...value,
              modelId: id,
              mode,
              quality,
              durationSeconds,
              withAudio: value.withAudio && next.supportsAudio,
              // A reference video only ever gets attached through the
              // dropzone this model's own ReferencePanel rendered — carrying
              // it into a model that doesn't support one would either be
              // silently dropped at submit or, worse, billed in a way this
              // app can't price (see rejectReferenceVideo in fal.ts).
              referenceVideoUrl: next.supportsReferenceVideo
                ? value.referenceVideoUrl
                : "",
              // Reference images carry over, but clipped to the new model's
              // own budget — Wan 2.7 allows 4, Wan 3.0 allows 10, and
              // submitting more than a model's endpoint expects is exactly
              // the kind of failure this clamp exists to avoid elsewhere.
              referenceImageUrls: value.referenceImageUrls.slice(
                0,
                next.maxReferences,
              ),
            });
          }}
        />
      </Field>

      <SegmentedControl
        options={model.modes.map((m) => ({
          value: m,
          label: MODE_LABEL[m],
          // Text-to-video is the whole trial. The free tier adds
          // image-to-video but still holds back reference-to-video — both
          // held back as the specific reasons to make an account or to
          // upgrade, same as duration/quality/audio above.
          locked: isTrial
            ? m !== TRIAL_MODE
            : isFree
              ? !FREE_MODES.includes(m)
              : false,
        }))}
        value={value.mode}
        onLocked={(m) => onLocked?.(m === "image2video" ? "image2video" : "reference")}
        onChange={(v) => {
          // Only a fully unlocked account reaches reference mode at all — the
          // "credit floor" is the balance check at submit time, same as any
          // other clip. This notice just gives the two benchmark numbers up
          // front, since reference jobs cost more than the default Standard
          // clip and "insufficient credit" after typing a whole prompt is a
          // worse moment to learn that.
          if (
            v === "reference2video" &&
            tier === "unlocked" &&
            (referenceProCents != null || referenceFourKCents != null)
          ) {
            setShowReferenceCreditNotice(true);
          }
          onChange({
            ...value,
            mode: v,
            // 4K has no reference endpoint — fall back rather than send a
            // tier the provider will reject.
            quality:
              v === "reference2video" && value.quality === "4k"
                ? "pro"
                : value.quality,
          });
        }}
      />

      {showReferenceCreditNotice && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-accent-500/30 bg-accent-500/[0.06] px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-ink-200">
            Reference clips cost more than a standard one. For comparison, a
            10-second clip runs about{" "}
            {referenceProCents != null && (
              <span className="text-white">
                {creditLabel(referenceProCents)} credits at Pro
              </span>
            )}
            {referenceProCents != null && referenceFourKCents != null && (
              <> or </>
            )}
            {referenceFourKCents != null && (
              <span className="text-white">
                {creditLabel(referenceFourKCents)} credits at 4K
              </span>
            )}
            . Worth checking your balance before generating.
          </p>
          <button
            type="button"
            onClick={() => setShowReferenceCreditNotice(false)}
            className="shrink-0 text-[11px] text-ink-400 transition hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* One consent for every upload slot below it. Placed above rather than
          below so it is read before a file is chosen, and mounted only when
          there is actually something to upload — a text-to-video user is not
          asked to affirm anything about files they never provide. */}
      {(isReference || usesFrames) && (
        <UploadConsentProvider>
          <div className="space-y-3">
            <ConsentCheckbox />

            {isReference && (
              <ReferencePanel
                model={model}
                videoUrl={value.referenceVideoUrl}
                imageUrls={value.referenceImageUrls}
                onVideoChange={(url) => set("referenceVideoUrl", url)}
                onImagesChange={(urls) => set("referenceImageUrls", urls)}
              />
            )}

            {usesFrames && (
              <div className="grid grid-cols-2 gap-3">
                <MediaDrop
                  label="Start frame"
                  value={value.imageUrl}
                  onChange={(url) => set("imageUrl", url)}
                  optional={isReference}
                  hint={
                    isReference
                      ? "Optional first frame."
                      : "Sets the output aspect ratio."
                  }
                />
                <MediaDrop
                  label="End frame"
                  value={value.endImageUrl}
                  onChange={(url) => set("endImageUrl", url)}
                  optional
                  hint="Motion interpolates toward this."
                  // Locked until the start frame has actually finished
                  // uploading — `imageUrl` only becomes truthy once
                  // MediaDrop's own upload resolves, so this is "disabled
                  // while uploading or empty" without needing a separate
                  // busy flag threaded up from the start frame's slot.
                  disabled={!value.imageUrl.trim()}
                  disabledHint="Add a start frame first"
                />
              </div>
            )}
          </div>
        </UploadConsentProvider>
      )}

      <Field label="Prompt">
        <textarea
          value={value.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          rows={5}
          placeholder="A lone figure walking a rain-slicked Tokyo alley at night, neon reflections in the puddles, slow dolly forward, shallow depth of field, 35mm."
          className="w-full resize-none rounded-lg border border-ink-650 bg-ink-850 px-3 py-2.5 text-sm leading-relaxed text-white outline-none placeholder:text-ink-400 focus:border-accent-500"
        />
        <div className="mt-1 flex items-start justify-between gap-3">
          {isReference ? (
            /* The model generates toward a description, not toward
               instructions — so the panel has to teach that, or people write
               "use these as references" and wonder why the output is weak. */
            <p className="text-[11px] leading-relaxed text-ink-400">
              Describe the shot and name each reference inside it — &ldquo;the
              jacket from ref 2&rdquo;. Say what should stay unchanged.
            </p>
          ) : (
            <span />
          )}
          <span
            className={`shrink-0 text-[11px] ${overLimit ? "text-red-400" : "text-ink-400"}`}
          >
            {value.prompt.length} / {model.maxPromptChars}
          </span>
        </div>
      </Field>

      <Field
        label="Aspect ratio"
        hint={
          value.mode === "image2video"
            ? "Ignored here — the start frame decides the shape."
            : ratioFollowsSource
              ? "Ignored here — the reference video decides the shape."
              : undefined
        }
      >
        <div
          className={`grid grid-cols-3 gap-2 ${
            value.mode === "image2video" || ratioFollowsSource
              ? "pointer-events-none opacity-40"
              : ""
          }`}
        >
          {model.aspectRatios.map((r) => (
            <button
              key={r}
              onClick={() => set("aspectRatio", r)}
              className={`rounded-lg border px-2 py-2.5 text-xs transition ${
                value.aspectRatio === r
                  ? "border-accent-400 bg-accent-500/20 text-white"
                  : "border-ink-650 bg-ink-850 text-ink-200 hover:border-ink-600"
              }`}
            >
              <span className="block font-medium">{r}</span>
              <span className="mt-0.5 block text-[10px] text-ink-400">
                {RATIO_LABEL[r]}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Duration">
        <SegmentedControl
          options={durationsFor(model, value.mode, !!value.referenceVideoUrl).map(
            (d) => ({
              value: d,
              label: `${d}s`,
              locked: isTrial
                ? d !== TRIAL_DURATION_SECONDS
                : isFree
                  ? !(FREE_DURATIONS as readonly number[]).includes(d)
                  : false,
            }),
          )}
          value={value.durationSeconds}
          onChange={(v) => set("durationSeconds", v)}
          onLocked={() => onLocked?.("duration")}
        />
      </Field>

      <Field
        label="Quality"
        hint={
          tierIgnored
            ? "Ignored here — the video-reference endpoint has a single tier."
            : value.quality === "4k"
              ? "Native 4K. Files are roughly 4× larger — mind your storage."
              : isReference
                ? "4K has no reference endpoint."
                : undefined
        }
      >
        <div className={tierIgnored ? "pointer-events-none opacity-40" : ""}>
          <SegmentedControl
            options={qualitiesFor(model, value.mode).map((q) => ({
              value: q,
              label: QUALITY_LABEL[q],
              locked: isTrial
                ? q !== TRIAL_QUALITY
                : isFree
                  ? q !== FREE_QUALITY
                  : false,
            }))}
            value={value.quality}
            onChange={(v) => set("quality", v)}
            onLocked={() => onLocked?.("quality")}
          />
        </div>
      </Field>

      {model.supportsAudio && (
        <label
          className="flex cursor-pointer items-center justify-between rounded-lg border border-ink-650 bg-ink-850 px-3 py-2.5"
          onClick={
            isTrial
              ? (e) => {
                  // Intercept on the label, before the checkbox toggles.
                  e.preventDefault();
                  onLocked?.("audio");
                }
              : undefined
          }
        >
          <span className="flex items-center gap-1.5 text-xs text-ink-200">
            Generate native audio
            {isTrial && <LockPip />}
          </span>
          <input
            type="checkbox"
            checked={value.withAudio}
            readOnly={isTrial}
            onChange={(e) => {
              if (isTrial) return;
              set("withAudio", e.target.checked);
            }}
            className="h-4 w-4 accent-[var(--color-accent-500)]"
          />
        </label>
      )}

      {/* Both of these are rejected outright by the reference endpoints, so in
          that mode the group is not disabled — it is simply not there. */}
      {!isReference && (
        <details className="group rounded-lg border border-ink-650 bg-ink-850">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs text-ink-200 transition hover:text-white">
            <span>Advanced</span>
            <span className="flex items-center gap-2 text-[10px] text-ink-400">
              {advancedTouched ? "Edited" : "Default"}
              <span className="inline-block transition group-open:rotate-90">
                ›
              </span>
            </span>
          </summary>

          <div className="space-y-4 border-t border-ink-800 px-3 py-3">
            <div>
              <span className="text-[11px] text-ink-300">Negative prompt</span>
              <textarea
                value={value.negativePrompt}
                onChange={(e) => set("negativePrompt", e.target.value)}
                rows={2}
                placeholder="blurry, warped hands, text overlay, watermark"
                className="mt-1.5 w-full resize-none rounded-lg border border-ink-650 bg-ink-900 px-3 py-2 text-sm text-white outline-none placeholder:text-ink-400 focus:border-accent-500"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-ink-300">
                  Prompt adherence
                </span>
                <span className="text-[11px] tabular-nums text-ink-400">
                  {value.cfgScale.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={value.cfgScale}
                onChange={(e) => set("cfgScale", Number(e.target.value))}
                className="mt-2 w-full accent-[var(--color-accent-500)]"
              />
              <p className="mt-1 text-[10px] leading-relaxed text-ink-400">
                Higher sticks to your words; lower gives the model room.
              </p>
            </div>
          </div>
        </details>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* A trial visitor who has spent their free clip must not meet a greyed
          "Not enough credit" button. That is a dead end at the exact moment
          they are most willing to hand over an email — so for them the button
          stays live and opens the ask instead. */}
      <button
        onClick={
          isTrial && (!affordable || disabled)
            ? () => onLocked?.("quota")
            : onSubmit
        }
        disabled={
          submitting ||
          (disabled && !isTrial) ||
          overLimit ||
          (!affordable && !isTrial) ||
          needsImage ||
          needsReference ||
          value.prompt.trim().length < 3
        }
        className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-accent-ink shadow-lg shadow-accent-500/20 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400 disabled:shadow-none"
      >
        {submitting
          ? "Submitting…"
          : isTrial && (!affordable || disabled)
            ? "Keep generating →"
            : disabled
              ? "Daily limit reached"
              : !affordable
                ? "Not enough credit"
                : needsReference
                  ? "Add a reference first"
                  : "Generate"}
      </button>

      {/* Says what the free clip is, so the missing Pro and other-length options
          read as a boundary rather than a bug. */}
      {isTrial && (
        <p className="text-center text-[11px] leading-relaxed text-ink-400">
          Your free clip is{" "}
          <span className="text-ink-200">text-to-video, 5 seconds</span>,
          Standard, no audio.
          <br />
          Anything marked with a lock opens with an email.
        </p>
      )}

      {/* Same reasoning, one tier up: the free account's caps are named here
          rather than left to look like a bug when Pro or Reference is
          missing. */}
      {isFree && (
        <p className="text-center text-[11px] leading-relaxed text-ink-400">
          Free tier:{" "}
          <span className="text-ink-200">Standard quality, up to 10 seconds</span>
          .
          <br />
          Anything marked with a lock needs a subscription or credit purchase.
        </p>
      )}

      {/* Customers see credits and nothing else. The dollar figures — and the
          provider cost behind them — are for the operator only. */}
      <p className="text-center text-[11px] text-ink-400">
        {resolutionFor(model, value.quality)} ·{" "}
        {billingEnabled ? (
          <>
            <span className="tabular-nums text-ink-200">
              {creditLabel(price)}
            </span>{" "}
            credits
            {value.withAudio && model.supportsAudio ? " · with audio" : ""}
          </>
        ) : (
          <>free while in beta</>
        )}
      </p>

      {isAdmin && (
        <p className="text-center text-[10px] tabular-nums text-ink-600">
          admin · charge ${(price / 100).toFixed(2)} · cost $
          {(cost / 100).toFixed(2)} · margin{" "}
          {cost > 0 ? Math.round(((price - cost) / price) * 100) : 0}%
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Small lime caps: the label reads as a section marker rather than
          competing with the control underneath it. */}
      <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.09em] text-accent-400">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-ink-300">{hint}</p>}
    </div>
  );
}

/**
 * A locked option is rendered, clickable, and dimmed — not removed and not
 * `disabled`. Removing it means nobody learns the feature exists; `disabled`
 * swallows the click, and the click is the entire point. It has to reach
 * `onLocked` so the ask can open.
 */
function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  onLocked,
}: {
  options: { value: T; label: string; locked?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  onLocked?: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-ink-650 bg-ink-850 p-1">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => (o.locked ? onLocked?.(o.value) : onChange(o.value))}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium transition ${
            value === o.value && !o.locked
              ? "bg-accent-500/20 text-white ring-1 ring-inset ring-accent-400/55"
              : o.locked
                ? "text-ink-400 hover:text-ink-200"
                : "text-ink-200 hover:text-white"
          }`}
        >
          {o.label}
          {o.locked && <LockPip />}
        </button>
      ))}
    </div>
  );
}

/** The one visual signal that something is behind the email ask. */
function LockPip() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0 opacity-70"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
    >
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}
