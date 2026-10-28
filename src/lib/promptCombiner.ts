"use client";

/**
 * Multi-element editing infrastructure: shared types for a selected scene
 * element's standalone edit record ("Dataset 1" in the spec that asked for
 * this) and the engine that folds every completed element into one combined
 * instruction + attachment package ("Dataset 2") ready for the existing
 * generate pipeline.
 *
 * Scope decisions made when this was built (so later changes know why):
 *  - optimizedPrompt is a straight pass-through of rawPrompt — no live
 *    OpenAI call. The "ChatGPT-style box" in the reference design is a UI
 *    shape (a prompt field + attachments + context), not a live model call
 *    yet, same as the rest of this app's prompt-drafting features.
 *  - Nothing here is persisted to a database. Both datasets live in React
 *    state for the lifetime of the Reference Editor tab (see PreparedClip's
 *    `elements` field in ReferenceEditor.tsx, which is what keeps a given
 *    clip's elements alive across opening/closing its selector modal — the
 *    state is lifted to the parent specifically so it isn't lost on
 *    remount).
 *  - "Combine" here means deterministic templating (numbered sections,
 *    stable attachment numbering, a closing invariants line), not an LLM
 *    rewrite — there's no model in the loop to do real sentence-level
 *    restructuring without the OpenAI integration above being turned on.
 *  - The combined prompt's text calls each attachment "Image N" / "@ImageN",
 *    not "Attachment N" — see the comment on `refLine` below. This has to
 *    match the literal numbering Mic Studio's own reference panel shows
 *    once the person lands there, not an internal name nothing else uses.
 */

export type ElementStatus = "not_started" | "completed";

export interface ElementAttachment {
  attachmentId: string;
  elementId: string;
  url: string;
  type: "image" | "video";
  filename: string;
  /** Same as `url` today — every attachment here is already an image or a
   * short video, both of which render fine as their own thumbnail. Kept as
   * a separate field because the spec calls for one, and a future video
   * attachment with a *generated* poster frame would set this differently
   * from `url`. */
  thumbnail: string;
  description?: string;
  order: number;
  createdAt: string;
}

/** One selected scene element's complete, independent edit record — Dataset
 * 1 in the spec. `elementId` is the stable identity; `label` is only ever a
 * display string and two elements may legitimately share one (e.g. two
 * separate "flower" selections), so nothing here keys off label. */
export interface ElementRecord {
  elementId: string;
  label: string;
  /** Highlight color used for this element's overlay on the frame —
   * carried over from the pre-existing selection UI, not part of the
   * original spec's schema but needed to keep that highlight working. */
  color: string;
  maskUrl: string;
  /** Equal to maskUrl today (see the file doc comment) — kept as its own
   * field since the spec calls for a distinct highlight-preview reference,
   * and a future "cropped region" preview would set this independently. */
  highlightPreviewUrl: string;
  sourceFrameSeconds: number;
  /** SAM 3's own confidence score for an AI-found mask, 0–1; null for a
   * manually drawn or pill-confirmed selection, which has no model score to
   * report. */
  detectionConfidence: number | null;
  rawPrompt: string;
  optimizedPrompt: string;
  attachments: ElementAttachment[];
  status: ElementStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Dataset2AttachmentRef {
  /** Stable "Attachment N" numbering referenced from combinedPrompt's text
   * — assigned once, in element order, and never renumbered afterward so
   * the prompt text and this list can't drift apart. */
  referenceNumber: number;
  attachmentId: string;
  elementId: string;
  url: string;
  type: "image" | "video";
}

export interface Dataset2Element {
  elementId: string;
  label: string;
  /** This element's "1.", "2." … position in combinedPrompt. */
  referenceIndex: number;
  maskUrl: string;
  rawPrompt: string;
  optimizedPrompt: string;
  attachmentNumbers: number[];
}

/** The combined edit package — Dataset 2 in the spec. This is what gets
 * handed to the existing downstream generation step: `combinedPrompt` maps
 * straight onto ReferenceTransferJob.prompt, and `attachments[].url`, taken
 * *in this array's own order*, maps onto ReferenceTransferJob.
 * referenceImageUrls — so "Image 1" in combinedPrompt's text is always
 * exactly attachments[0].url, which Studio's ReferencePanel then renders
 * into the slot it itself badges "@Image1", on both Kling and Wan (see
 * ReferencePanel.tsx and the provider adapters in lib/providers/fal.ts,
 * neither of which reorders this array at any point). The trimmed clip
 * itself never goes through this list at all — it's always
 * ReferenceTransferJob.referenceVideoUrl, set once in ReferenceEditor.tsx
 * when the clip is cut, untouched by element selection or this engine. */
export interface Dataset2 {
  jobId: string;
  combinedPrompt: string;
  elements: Dataset2Element[];
  attachments: Dataset2AttachmentRef[];
  createdAt: string;
}

/**
 * Folds every completed element into one Dataset 2 package. Takes only
 * *completed* elements — the caller (the Done button's confirmation flow)
 * is responsible for deciding what happens to elements still missing an
 * instruction; this function never invents one.
 */
export function buildCombinedPrompt(elements: ElementRecord[]): Dataset2 {
  const attachments: Dataset2AttachmentRef[] = [];
  const datasetElements: Dataset2Element[] = [];
  const blocks: string[] = [];
  let refCounter = 0;

  elements.forEach((el, i) => {
    const nums: number[] = [];
    for (const a of el.attachments) {
      refCounter += 1;
      attachments.push({
        referenceNumber: refCounter,
        attachmentId: a.attachmentId,
        elementId: el.elementId,
        url: a.url,
        type: a.type,
      });
      nums.push(refCounter);
    }

    // "Image N" / "@ImageN", not "Attachment N" — these have to read as the
    // exact same reference a person sees once they land in Mic Studio.
    // ReferencePanel.tsx renders each uploaded reference image with an
    // "@ImageN" badge in this same left-to-right order (see its own doc
    // comment: Kling addresses images positionally from inside the prompt
    // via that literal @ImageN token), and `onSave`'s referenceImageUrls —
    // built from this function's own `attachments` list below, in this same
    // order — are what fills those numbered slots. Calling it "Attachment
    // N" here would describe a label nothing in the UI or either provider's
    // addressing convention actually uses.
    const refLine =
      nums.length === 0
        ? ""
        : nums.length === 1
          ? ` Use Image ${nums[0]} (@Image${nums[0]}) as the reference.`
          : ` Use Images ${nums.slice(0, -1).join(", ")} and ${nums[nums.length - 1]} (@Image${nums.join(", @Image")}) as references.`;

    blocks.push(
      `${i + 1}. "${el.label}"\n${el.optimizedPrompt.trim()}${refLine}`,
    );

    datasetElements.push({
      elementId: el.elementId,
      label: el.label,
      referenceIndex: i + 1,
      maskUrl: el.maskUrl,
      rawPrompt: el.rawPrompt,
      optimizedPrompt: el.optimizedPrompt,
      attachmentNumbers: nums,
    });
  });

  const intro =
    elements.length === 1
      ? "Edit the highlighted element in the source image:"
      : `Edit the ${elements.length} highlighted elements in the source image:`;

  // One standing invariant appended once rather than repeated per element —
  // this is what the spec's "retain camera perspective / composition /
  // lighting / non-selected elements unless instructed otherwise" rules
  // become without an LLM to restate them element-by-element: a single
  // generic closing constraint, true regardless of which elements were
  // picked, so it's safe to state without knowing anything about them.
  const closing =
    "Keep everything else in the scene — composition, camera angle, lighting, and any elements not listed above — unchanged unless an instruction above says otherwise.";

  const combinedPrompt = [intro, ...blocks, closing].join("\n\n");

  return {
    jobId: `edit_job_${Date.now().toString(36)}`,
    combinedPrompt,
    elements: datasetElements,
    attachments,
    createdAt: new Date().toISOString(),
  };
}
