"use client";

import MediaDrop from "./MediaDrop";
import { imageReferenceBudget, type ModelDef } from "@/lib/models";

/**
 * Reference inputs for reference-to-video.
 *
 * Kling addresses these positionally from inside the prompt — @Image1 is the
 * first image slot, @Element1 is the video. That's why the slots are numbered
 * in the UI: the number is not decoration, it's the handle you type.
 *
 * A reference video consumes one of the four reference slots, so adding one
 * drops the image budget to three. The panel enforces that rather than letting
 * the provider reject the request after you've waited for it.
 *
 * The video dropzone only renders for a model with `supportsReferenceVideo`
 * set (Kling only, today) — Wan's reference endpoints technically accept a
 * reference video too, but bill it in a way this app can't price upfront
 * (see the Wan model doc comments in lib/models.ts), so the control simply
 * isn't offered rather than being offered and then failing or mis-billing.
 */
export default function ReferencePanel({
  model,
  videoUrl,
  imageUrls,
  onVideoChange,
  onImagesChange,
}: {
  model: ModelDef;
  videoUrl: string;
  imageUrls: string[];
  onVideoChange: (url: string) => void;
  onImagesChange: (urls: string[]) => void;
}) {
  const budget = imageReferenceBudget(model);
  const shown = imageUrls.slice(0, budget);
  const slots = [...shown];
  if (slots.length < budget) slots.push("");

  function setImageAt(index: number, url: string) {
    const next = [...imageUrls];
    if (url) next[index] = url;
    else next.splice(index, 1);
    onImagesChange(next.filter(Boolean).slice(0, budget));
  }

  const overBudget = imageUrls.length > budget;

  return (
    <div className="space-y-4 rounded-xl border border-ink-650 bg-ink-850/60 p-3">
      {model.supportsReferenceVideo && (
        <MediaDrop
          label="Video reference"
          kind="video"
          value={videoUrl}
          onChange={onVideoChange}
          optional
          hint="Motion and framing are followed from this clip — say what should stay unchanged. MP4 or MOV, 3–10s, up to 200 MB."
        />
      )}

      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <label className="text-[10px] font-medium uppercase tracking-[0.09em] text-accent-400">
            Image references
          </label>
          <span className="text-[10px] text-ink-400">
            {shown.length} / {budget}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {slots.map((url, i) => (
            <div key={i} className="relative">
              <MediaDrop
                value={url}
                onChange={(v) => setImageAt(i, v)}
                compact
              />
              {url && (
                <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-white backdrop-blur">
                  @Image{i + 1}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* The @-token convention came from another product's UI; Kling maps
            references by plain description, so teaching @Image2 was steering
            people straight into weak output. */}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-300">
          Name each one inside your description — “the jacket from ref 2”.
          Mapping them explicitly stops the model blending them together.
        </p>

        {videoUrl && (
          <p className="mt-1.5 text-[11px] text-ink-400">
            With a video attached this runs on Kling O1, which follows the
            clip&apos;s motion, audio <em>and frame shape</em> — the output
            matches this clip&apos;s aspect ratio, not the buttons below.
          </p>
        )}

        {overBudget && (
          <p className="mt-1.5 text-[11px] text-amber-400">
            Only the first {budget} images will be sent.
          </p>
        )}
      </div>
    </div>
  );
}
