"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { uploadMedia } from "@/lib/upload";
import { captureThumbnail } from "@/lib/videoThumbnail";
import {
  buildCombinedPrompt,
  type ElementAttachment,
  type ElementRecord,
} from "@/lib/promptCombiner";

interface PendingMask {
  maskUrl: string;
  name: string;
  score: number | null;
}

/** A manually dragged rectangle, in 0–1 fractions of the frame image — not
 * pixels, so it stays correct regardless of how large the frame is rendered
 * on screen. */
interface DragRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function normalizeRect(r: DragRect) {
  return {
    left: Math.min(r.x0, r.x1),
    top: Math.min(r.y0, r.y1),
    right: Math.max(r.x0, r.x1),
    bottom: Math.max(r.y0, r.y1),
  };
}

/** A point in a freehand (pencil) stroke, same 0–1 fraction convention as
 * DragRect. */
interface Point {
  x: number;
  y: number;
}

/** A finished manual selection waiting to be named — either shape rasterizes
 * to a mask the same way everything downstream (highlight overlay, the
 * element record) is already built to consume. */
type ManualShape =
  | { kind: "box"; rect: DragRect }
  | { kind: "pencil"; points: Point[] };

/** One bubble in a per-element edit chat — either the person's own typed
 * instruction, or the actual edited frame that came back for it (real or
 * mock; `mock` is only set on a freshly-generated result, never on one
 * reconstructed from a reopened element — see openEditor). */
type EditorMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "result"; imageUrl: string; mock?: boolean }
  // A system-style note (e.g. "↻ regenerated the selection") — shown in the
  // thread for context but never counted as an instruction: excluded from
  // the text saveEditor folds into rawPrompt, and from what regenerateSelection
  // treats as "the last thing typed".
  | { id: string; role: "note"; text: string };

/** Bounding box of a freehand stroke, in the same shape normalizeRect
 * returns, so both shapes can share one minimum-size check. */
function pointsBounds(points: Point[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/**
 * Distinct, colorblind-friendlyish hues so several elements read as separate
 * highlights at a glance rather than one blob. Cycles if there are more
 * elements than colors — unlikely for a handful per clip, and a repeat is
 * harmless (the label still disambiguates).
 */
const HIGHLIGHT_COLORS = [
  "#22d3ee", // cyan
  "#f472b6", // pink
  "#facc15", // yellow
  "#a78bfa", // violet
  "#fb923c", // orange
  "#4ade80", // green
];

/**
 * Multi-element editing for one prepared scene clip: find/mark a region
 * (AI-detected, tapped from an auto-suggestion pill, or hand-drawn), then —
 * separately, per element — write what should happen to it and attach its
 * own reference media. Every selected element is tracked as its own
 * `ElementRecord` ("Dataset 1" in the spec this was built from); on Done,
 * every *completed* element (one with a saved instruction) is folded by
 * `buildCombinedPrompt` (lib/promptCombiner.ts) into one combined prompt +
 * attachment list ("Dataset 2") handed back to the Reference Editor.
 *
 * `elements` is a controlled prop, not local state: this component remounts
 * every time its clip's modal is reopened (see ReferenceEditor's
 * `{selectorClip && meta && (<SceneObjectSelector .../>)}`), and the spec
 * explicitly requires returning to an already-configured element without
 * losing its data — so the array itself, and every element's attachments
 * and instruction, live on the parent (`PreparedClip.elements`) and simply
 * survive this component unmounting.
 *
 * Finding a region, two ways:
 *  - Describing what to select, not clicking it: SAM 3 is a *text-concept*
 *    segmentation model, not classic click-anywhere SAM — a point alone,
 *    with no description, silently fell back to fal's own default search
 *    concept and never found anything on a real frame. Typing a short
 *    phrase ("the red jacket", "the dog") is what the model needs, and
 *    becomes the element's starting label.
 *  - "Draw manually" (box or freehand pencil) is a separate, entirely
 *    client-side path — not a fal call at all. SAM 3 can miss a concept
 *    outright ("grapefruit" finding nothing) or lump distinct objects into
 *    one mask ("fruit" matching everything fruit-shaped at once); a person
 *    drawing exactly what they mean is the reliable fallback. The shape is
 *    rasterized straight into a mask image in the browser and treated
 *    identically to an AI-found mask everywhere after that.
 *
 * optimizedPrompt is a pass-through of what the user typed in the per-
 * element editor — see the longer note in lib/promptCombiner.ts on why
 * there's no live OpenAI call here yet.
 */
export default function SceneObjectSelector({
  sourceUrl,
  sourceWidth,
  sourceHeight,
  clipStart,
  clipEnd,
  presetFrameDataUrl,
  elements,
  onElementsChange,
  granted,
  onClose,
  onSave,
}: {
  sourceUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  clipStart: number;
  clipEnd: number;
  /** When set (a "Take Snap" still, already captured at a specific moment
   * the person scrubbed to), this exact frame is used directly instead of
   * extracting one from sourceUrl via clipStart/clipEnd's midpoint — see
   * the prepareFrame effect below. sourceUrl/clipStart/clipEnd are still
   * required by the type (and still used for the Dataset 1 record's own
   * sourceFrameSeconds bookkeeping) even in this case. sourceWidth/
   * sourceHeight should be this frame's own pixel size when this is set,
   * not the parent clip's. */
  presetFrameDataUrl?: string | null;
  elements: ElementRecord[];
  onElementsChange: (
    updater: (prev: ElementRecord[]) => ElementRecord[],
  ) => void;
  granted: boolean;
  onClose: () => void;
  onSave: (result: { prompt: string; referenceImageUrls: string[] }) => void;
}) {
  const elementSeq = useRef(0);
  const attachmentSeq = useRef(0);
  const frameSeq = useRef(0);
  const frameBoxRef = useRef<HTMLDivElement | null>(null);

  const [frameDataUrl, setFrameDataUrl] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loadingFrame, setLoadingFrame] = useState(true);
  const [describeText, setDescribeText] = useState("");
  const [segmenting, setSegmenting] = useState(false);
  const [pending, setPending] = useState<PendingMask | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [pillBusy, setPillBusy] = useState<string | null>(null);
  const nextColor = (count: number) =>
    HIGHLIGHT_COLORS[count % HIGHLIGHT_COLORS.length];

  // Manual drawing fallback — see the component doc comment above. "box" vs
  // "pencil" picks the stroke shape; "add"/"subtract" (the two boolean-op
  // buttons) picks how each finished stroke combines into the selection
  // being built — several strokes, of either shape, fold together onto one
  // accumulator canvas (manualAccumCanvasRef) before it's named and turned
  // into an element, the same way Photoshop/Figma's add/subtract selection
  // modes work. `pendingMaskUrl` is a snapshot of that accumulator after
  // the most recent stroke — both what the naming UI confirms and what's
  // shown as a live highlight on the frame while more strokes are added.
  const [manualMode, setManualMode] = useState(false);
  const [drawShape, setDrawShape] = useState<"box" | "pencil">("box");
  const [manualCombineMode, setManualCombineMode] = useState<
    "add" | "subtract"
  >("add");
  const [dragRect, setDragRect] = useState<DragRect | null>(null);
  const [freehandPoints, setFreehandPoints] = useState<Point[] | null>(null);
  const [pendingMaskUrl, setPendingMaskUrl] = useState<string | null>(null);
  const manualAccumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [manualName, setManualName] = useState("");
  const draggingRef = useRef(false);

  // Per-element editor — opened by the ✨ icon on a list row, styled as a
  // small chat so writing, re-reading, and revising an instruction feels
  // like a running conversation about this one element rather than a
  // single-shot form. Drafted separately from `elements` so Cancel can
  // discard changes cleanly. There's no model replying in this thread (see
  // lib/promptCombiner.ts's pass-through note) — every bubble here is the
  // person's own message; "sending" one just appends it to the instruction
  // text that gets saved.
  const [editingElementId, setEditingElementId] = useState<string | null>(
    null,
  );
  const [draftLabel, setDraftLabel] = useState("");
  const [draftMessages, setDraftMessages] = useState<EditorMessage[]>([]);
  const [composeText, setComposeText] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<
    ElementAttachment[]
  >([]);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // The most recent actual edited frame from this chat (real or mock) —
  // what Save writes onto the element as `generatedImageUrl`. Separate from
  // `draftMessages` (which is just the thread for display) so Save doesn't
  // have to go hunting backward through the thread for the last result
  // bubble.
  const [lastGeneratedUrl, setLastGeneratedUrl] = useState<string | null>(
    null,
  );
  const [generating, setGenerating] = useState(false);
  const messageSeq = useRef(0);
  const editingElement =
    elements.find((e) => e.elementId === editingElementId) ?? null;

  const [showIncompleteWarning, setShowIncompleteWarning] = useState(false);

  /**
   * The one running composite frame every element's edit builds onto,
   * across the whole session — what makes editing two different elements
   * ("add orange" on one region, "drone view" on another) land as ONE
   * image showing both, instead of two separate images each only showing
   * its own edit. Every Send, regardless of which element's chat it comes
   * from, reads this as its starting image (see sendComposedMessage) and
   * writes its result back here — so the chain is strictly "whatever was
   * sent most recently, across every element," not per-element. Finalize
   * hands this (not any one element's own generatedImageUrl) to
   * buildCombinedPrompt as the single combined reference image.
   *
   * Initialized from whichever element (searched last-to-first, since nothing
   * records which one was truly edited most recently across a *previous*
   * session) already has a saved `generatedImageUrl`, so reopening a
   * partially-edited clip/snap and editing one more element still chains
   * onto earlier work instead of silently resetting to the untouched frame.
   * Stays null — meaning "nothing's been AI-edited yet this session" — until
   * the first successful Send; buildCombinedPrompt treats that null case as
   * "fall back to each element's own stored image/attachments," which is
   * also what makes a reopen-with-no-further-edits round-trip unchanged.
   */
  const [sessionImageUrl, setSessionImageUrl] = useState<string | null>(
    () => {
      for (let i = elements.length - 1; i >= 0; i--) {
        if (elements[i].generatedImageUrl) return elements[i].generatedImageUrl;
      }
      return null;
    },
  );

  useEffect(() => {
    let cancelled = false;

    async function prepareFrame() {
      setLoadingFrame(true);
      setError(null);
      try {
        // Capped at 960px wide and kept at the source's own aspect ratio —
        // stretching to a fixed box would distort the frame fal actually
        // sees, which is otherwise unnecessary: this app's reference clips
        // are already 16:9/9:16/1:1, so the source's own ratio is already
        // one of those.
        const width = 960;
        const height = Math.max(
          1,
          Math.round((width * (sourceHeight || 1)) / (sourceWidth || 1)),
        );
        const dataUrl = presetFrameDataUrl
          ? presetFrameDataUrl
          : await captureThumbnail(
              sourceUrl,
              (clipStart + clipEnd) / 2,
              width,
              height,
            );
        if (!dataUrl) {
          throw new Error(
            "Could not capture a frame from this clip to select from.",
          );
        }
        if (cancelled) return;
        setFrameDataUrl(dataUrl);
        setFrameSize({ width, height });

        const blob = await (await fetch(dataUrl)).blob();
        frameSeq.current += 1;
        const file = new File([blob], `frame-${frameSeq.current}.jpg`, {
          type: "image/jpeg",
        });
        const url = await uploadMedia(file, "image", granted);
        if (cancelled) return;
        setFrameUrl(url);
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Could not prepare this frame.",
          );
        }
      } finally {
        if (!cancelled) setLoadingFrame(false);
      }
    }

    void prepareFrame();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, clipStart, clipEnd, presetFrameDataUrl]);

  // Auto-detect pills: a best-effort suggestion list, so most of the time
  // nobody has to type a description from scratch at all. Deliberately
  // separate from the frame-prep effect above and from the blocking `error`
  // state — Florence-2 having a bad moment, or finding nothing, should never
  // stop the rest of the selector from working; it just means the pill row
  // stays empty and manual typing is still right there.
  useEffect(() => {
    if (!frameUrl) return;
    let cancelled = false;

    (async () => {
      setLoadingCandidates(true);
      setCandidates([]);
      try {
        const res = await fetch("/api/detect-labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: frameUrl }),
        });
        const json = (await res.json()) as { labels?: unknown };
        if (!cancelled && res.ok && Array.isArray(json.labels)) {
          setCandidates(
            json.labels.filter((l): l is string => typeof l === "string"),
          );
        }
      } catch {
        // Best-effort — see comment above.
      } finally {
        if (!cancelled) setLoadingCandidates(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [frameUrl]);

  /** Creates a new element record from a found/drawn mask and hands it to
   * the parent — the single path every detection method (typed, pill,
   * manual) funnels through, so id/color/timestamp assignment only lives in
   * one place. */
  function addElement(
    label: string,
    maskUrl: string,
    confidence: number | null,
  ) {
    elementSeq.current += 1;
    const elementId = `element_${String(elementSeq.current).padStart(3, "0")}`;
    const now = new Date().toISOString();
    onElementsChange((prev) => [
      ...prev,
      {
        elementId,
        label,
        color: nextColor(prev.length),
        maskUrl,
        highlightPreviewUrl: maskUrl,
        sourceFrameSeconds: (clipStart + clipEnd) / 2,
        detectionConfidence: confidence,
        rawPrompt: "",
        optimizedPrompt: "",
        attachments: [],
        generatedImageUrl: null,
        status: "not_started",
        createdAt: now,
        updatedAt: now,
      },
    ]);
  }

  function removeElement(elementId: string) {
    onElementsChange((prev) => prev.filter((e) => e.elementId !== elementId));
    if (editingElementId === elementId) setEditingElementId(null);
  }

  function elementForLabel(label: string) {
    const needle = label.trim().toLowerCase();
    return elements.find((e) => e.label.trim().toLowerCase() === needle);
  }

  async function handleDetect() {
    const text = describeText.trim();
    if (!frameUrl || !text || segmenting) return;

    setSegmenting(true);
    setError(null);
    setPending(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, prompt: text }),
      });
      const json = (await res.json()) as {
        maskUrl?: string;
        score?: number;
        error?: string;
      };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? "Could not detect that.");
      }
      setPending({
        maskUrl: json.maskUrl,
        name: text,
        score: typeof json.score === "number" ? json.score : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not detect that.");
    } finally {
      setSegmenting(false);
    }
  }

  function keepPending() {
    if (!pending) return;
    addElement(pending.name, pending.maskUrl, pending.score);
    setPending(null);
    setDescribeText("");
  }

  /** 0–1 fraction of the frame image under a pointer event, clamped so a
   * drag that leaves the image (e.g. onto the letterbox bars) still resolves
   * to a valid point instead of going out of bounds. */
  function fractionFromEvent(e: PointerEvent): { x: number; y: number } {
    const box = frameBoxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    };
  }

  function startManualDraw(e: PointerEvent) {
    if (!manualMode) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const p = fractionFromEvent(e);
    if (drawShape === "box") {
      setDragRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else {
      setFreehandPoints([p]);
    }
  }

  function moveManualDraw(e: PointerEvent) {
    if (!draggingRef.current) return;
    const p = fractionFromEvent(e);
    if (drawShape === "box") {
      setDragRect((prev) => (prev ? { ...prev, x1: p.x, y1: p.y } : prev));
    } else {
      setFreehandPoints((prev) => {
        if (!prev) return prev;
        // Skip near-duplicate points (a stationary or slow-moving pointer
        // firing many move events) — keeps the point count, and therefore
        // the eventual mask path, sane without a visible difference.
        const last = prev[prev.length - 1];
        if (
          last &&
          Math.abs(last.x - p.x) < 0.004 &&
          Math.abs(last.y - p.y) < 0.004
        ) {
          return prev;
        }
        return [...prev, p];
      });
    }
  }

  function endManualDraw() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (drawShape === "box") {
      setDragRect((prev) => {
        if (!prev) return null;
        const r = normalizeRect(prev);
        // Ignore an accidental tap/click — require a real drag.
        if (r.right - r.left < 0.02 || r.bottom - r.top < 0.02) return null;
        commitManualStroke({ kind: "box", rect: prev });
        return null;
      });
    } else {
      setFreehandPoints((prev) => {
        if (!prev || prev.length < 3) return null;
        const b = pointsBounds(prev);
        // Same accidental-tap guard as the box tool.
        if (b.right - b.left < 0.02 && b.bottom - b.top < 0.02) return null;
        commitManualStroke({ kind: "pencil", points: prev });
        return null;
      });
    }
  }

  /** Fills a finished shape's path onto whatever canvas/context the caller
   * set up (fillStyle and compositeOperation are the caller's to control) —
   * a box fills a rect; a pencil stroke fills the closed polygon its points
   * trace, `closePath` connecting the last point back to the first, same as
   * the live SVG preview already shows while drawing. Shared by both the
   * add and subtract paths in commitManualStroke below, since painting the
   * shape itself is identical either way — only the compositing differs. */
  function paintShapePath(
    ctx: CanvasRenderingContext2D,
    shape: ManualShape,
    size: { width: number; height: number },
  ) {
    if (shape.kind === "box") {
      const r = normalizeRect(shape.rect);
      ctx.fillRect(
        r.left * size.width,
        r.top * size.height,
        (r.right - r.left) * size.width,
        (r.bottom - r.top) * size.height,
      );
    } else {
      const [first, ...rest] = shape.points;
      ctx.beginPath();
      ctx.moveTo(first.x * size.width, first.y * size.height);
      for (const p of rest) {
        ctx.lineTo(p.x * size.width, p.y * size.height);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Paints one finished box/pencil stroke onto the running selection being
   * built — manualAccumCanvasRef, created lazily and kept alive across
   * strokes until the selection is named (confirmManualSelection) or
   * abandoned (resetManualSelection). The very first stroke of a fresh
   * selection always adds, regardless of which combine button is active —
   * subtracting from nothing would just be a confusing no-op — every stroke
   * after that follows manualCombineMode: "add" paints in normal
   * source-over (white-on-white still reads as the same opaque selection,
   * so overlapping an existing region back in is harmless), "subtract"
   * paints with destination-out, which erases wherever the new shape's
   * alpha is set regardless of its fill color, carving it out of whatever
   * was already there.
   */
  function commitManualStroke(shape: ManualShape) {
    if (!frameSize) return;
    let canvas = manualAccumCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = frameSize.width;
      canvas.height = frameSize.height;
      manualAccumCanvasRef.current = canvas;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Could not create that selection — try again.");
      return;
    }
    const isFirstStroke = pendingMaskUrl === null;
    ctx.globalCompositeOperation =
      isFirstStroke || manualCombineMode === "add"
        ? "source-over"
        : "destination-out";
    ctx.fillStyle = "#ffffff";
    paintShapePath(ctx, shape, frameSize);
    ctx.globalCompositeOperation = "source-over";
    setPendingMaskUrl(canvas.toDataURL("image/png"));
  }

  /** Discards the in-progress accumulator so the next stroke starts a brand
   * new selection — used by Cancel, Escape, and toggling manual mode off. */
  function resetManualSelection() {
    manualAccumCanvasRef.current = null;
    setPendingMaskUrl(null);
  }

  function confirmManualSelection() {
    const name = manualName.trim();
    if (!pendingMaskUrl || !name) return;
    addElement(name, pendingMaskUrl, null);
    resetManualSelection();
    setManualName("");
  }

  /**
   * One click on an auto-detected pill either adds or removes it — unlike
   * the manual-typing path, there's no "Found X — keep it?" confirmation
   * step here, since Florence-2 already named the object before the pill
   * ever appeared; SAM 3 is only asked to turn that name into a mask.
   */
  async function addByLabel(label: string) {
    const existing = elementForLabel(label);
    if (existing) {
      removeElement(existing.elementId);
      return;
    }
    if (!frameUrl || pillBusy) return;

    setPillBusy(label);
    setError(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, prompt: label }),
      });
      const json = (await res.json()) as {
        maskUrl?: string;
        score?: number;
        error?: string;
      };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? `Could not detect "${label}".`);
      }
      addElement(
        label,
        json.maskUrl,
        typeof json.score === "number" ? json.score : null,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : `Could not detect "${label}".`,
      );
    } finally {
      setPillBusy(null);
    }
  }

  function openEditor(el: ElementRecord) {
    setEditingElementId(el.elementId);
    setDraftLabel(el.label);
    // A previously saved instruction — and its generated result, if this
    // element has one — reopens already in the thread, so coming back to an
    // element picks the conversation back up instead of starting over.
    const seeded: EditorMessage[] = [];
    if (el.rawPrompt) seeded.push({ id: "seed-user", role: "user", text: el.rawPrompt });
    if (el.generatedImageUrl) {
      seeded.push({
        id: "seed-result",
        role: "result",
        imageUrl: el.generatedImageUrl,
      });
    }
    setDraftMessages(seeded);
    setComposeText("");
    setDraftAttachments(el.attachments);
    setLastGeneratedUrl(el.generatedImageUrl);
    setEditorError(null);
  }

  /**
   * Both the header "Close" link and the footer "Cancel" button route here.
   * Neither autosaves — only the "Save" button writes the thread back onto
   * the element (see saveEditor) — so closing this straight after "Send"
   * silently threw away a just-generated result if the person hadn't
   * noticed they still needed to scroll down and press Save. This now
   * checks for exactly that and asks first, rather than discarding
   * something that took a real OpenAI call to produce.
   */
  function closeEditor() {
    if (editingElement) {
      const draftPrompt = [
        ...draftMessages
          .filter((m): m is Extract<EditorMessage, { role: "user" }> =>
            m.role === "user",
          )
          .map((m) => m.text),
        composeText.trim(),
      ]
        .filter((t) => t.length > 0)
        .join("\n\n");
      const attachmentsChanged =
        draftAttachments.length !== editingElement.attachments.length ||
        draftAttachments.some(
          (a, i) =>
            a.attachmentId !== editingElement.attachments[i]?.attachmentId,
        );
      const hasUnsavedChanges =
        draftPrompt !== editingElement.rawPrompt ||
        lastGeneratedUrl !== editingElement.generatedImageUrl ||
        attachmentsChanged;
      if (
        hasUnsavedChanges &&
        !window.confirm(
          "This element has a generated result or typed instruction that hasn't been saved yet. Close without saving it?",
        )
      ) {
        return;
      }
    }
    setEditingElementId(null);
    setEditorError(null);
  }

  function removeEditingElement() {
    if (!editingElementId) return;
    // removeElement already clears editingElementId when it matches, which
    // also closes this overlay — one path for "remove" everywhere.
    removeElement(editingElementId);
  }

  /**
   * Sends what's typed as a user bubble, then actually generates this
   * element's edited frame from it via /api/edit-element — the real "edit"
   * in edit/remove/regenerate. That route itself decides mock vs. real
   * (the admin switch on /admin; see lib/elementEditSettings.ts), so this
   * component never needs to know which one is active — it just renders
   * whatever comes back, labeled if it was a mock run.
   *
   * Two things make a follow-up like "just one, not multiple" actually
   * read as a follow-up instead of a fresh, unrelated instruction — OpenAI's
   * edit endpoint has no memory between calls, it only sees whatever single
   * image+mask+prompt this one request sends:
   *   - `imageUrl` is the most recent generated result once there is one,
   *     not always the original frame — so the edit lands on the apple
   *     photo that's already on screen, not back on the untouched original.
   *   - `prompt` resends every earlier instruction in this thread (oldest
   *     first) plus the one just typed, joined into one block — so "with a
   *     drone view" from two messages ago is still part of what the model
   *     reads this time, not lost the moment the next message is sent.
   *
   * That "most recent generated result" is `sessionImageUrl`, not this one
   * element's own `lastGeneratedUrl` — deliberately shared across every
   * element in this selector, not scoped to whichever one is currently
   * open. That's what makes editing element A then element B land as ONE
   * image with both edits: B's edit is generated starting from A's result,
   * not from the untouched original frame, so A's change is still there
   * (outside B's own mask) once B's edit comes back. See `sessionImageUrl`'s
   * own doc comment and buildCombinedPrompt in lib/promptCombiner.ts, which
   * is what actually hands this single composite to Mic Studio as the
   * combined reference image instead of one image per element.
   *
   * Nothing is written onto the element itself until Save — this only
   * updates the thread (`draftMessages`), `lastGeneratedUrl`, and
   * `sessionImageUrl`, so Cancel still discards everything cleanly, same as
   * before this call existed (sessionImageUrl is only ever read at Done/
   * finalize time, never persisted until then).
   */
  async function sendComposedMessage() {
    const text = composeText.trim();
    if (!text || generating || !editingElement || !frameUrl) return;

    const priorInstructions = draftMessages
      .filter(
        (m): m is Extract<EditorMessage, { role: "user" }> =>
          m.role === "user",
      )
      .map((m) => m.text);
    const combinedPrompt = [...priorInstructions, text].join("\n\n");

    messageSeq.current += 1;
    const userMessage: EditorMessage = {
      id: `msg_${messageSeq.current}`,
      role: "user",
      text,
    };
    setDraftMessages((prev) => [...prev, userMessage]);
    setComposeText("");
    setGenerating(true);
    setEditorError(null);

    try {
      const res = await fetch("/api/edit-element", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: sessionImageUrl ?? frameUrl,
          maskUrl: editingElement.maskUrl,
          prompt: combinedPrompt,
        }),
      });
      const json = (await res.json()) as {
        url?: string;
        mock?: boolean;
        error?: string;
      };
      if (!res.ok || !json.url) {
        throw new Error(json.error ?? "Could not generate that edit.");
      }
      messageSeq.current += 1;
      setDraftMessages((prev) => [
        ...prev,
        {
          id: `msg_${messageSeq.current}`,
          role: "result",
          imageUrl: json.url!,
          mock: !!json.mock,
        },
      ]);
      setLastGeneratedUrl(json.url);
      setSessionImageUrl(json.url);
    } catch (e) {
      setEditorError(
        e instanceof Error ? e.message : "Could not generate that edit.",
      );
    } finally {
      setGenerating(false);
    }
  }

  /** Re-runs detection for this one element using whatever's been typed
   * (composer first, else the latest sent message, else the label) as the
   * new description — the "regenerate the highlighted element" half of the
   * request. Updates the element's own mask in place, so its highlight
   * (here and back on the main frame) and its saved selection both move to
   * the new region without starting a new element. */
  async function regenerateSelection() {
    if (!editingElementId || !frameUrl || regenerating) return;
    const lastUserText = [...draftMessages]
      .reverse()
      .find((m): m is Extract<EditorMessage, { role: "user" }> =>
        m.role === "user",
      )?.text;
    const prompt = (composeText.trim() || lastUserText || draftLabel).trim();
    if (!prompt) {
      setEditorError("Type what to select before regenerating.");
      return;
    }
    setRegenerating(true);
    setEditorError(null);
    try {
      const res = await fetch("/api/segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: frameUrl, prompt }),
      });
      const json = (await res.json()) as {
        maskUrl?: string;
        score?: number;
        error?: string;
      };
      if (!res.ok || !json.maskUrl) {
        throw new Error(json.error ?? "Could not regenerate that selection.");
      }
      const maskUrl = json.maskUrl;
      const now = new Date().toISOString();
      onElementsChange((prev) =>
        prev.map((e) =>
          e.elementId === editingElementId
            ? {
                ...e,
                maskUrl,
                highlightPreviewUrl: maskUrl,
                detectionConfidence:
                  typeof json.score === "number" ? json.score : null,
                updatedAt: now,
              }
            : e,
        ),
      );
      messageSeq.current += 1;
      setDraftMessages((prev) => [
        ...prev,
        {
          id: `msg_${messageSeq.current}`,
          role: "note",
          text: `↻ Regenerated the highlighted selection for "${prompt}".`,
        },
      ]);
    } catch (e) {
      setEditorError(
        e instanceof Error
          ? e.message
          : "Could not regenerate that selection.",
      );
    } finally {
      setRegenerating(false);
    }
  }

  /**
   * Images only, deliberately — not the "potentially video reference later"
   * the original spec left open. Mic Studio's reference panel has exactly
   * one video slot total (the already-trimmed source clip itself,
   * `referenceVideoUrl`, set once when the clip was cut) and a *list* of
   * numbered image slots; an element's own reference attachment lands in
   * that image list (see the Dataset2 doc comment above), which has no
   * sensible destination for a second, unrelated video. Accepting video
   * here would let it flow into `referenceImageUrls` and silently arrive at
   * an image dropzone in Studio.
   */
  async function handleAttachmentFiles(files: FileList | null) {
    if (!files || !files.length || !editingElementId) return;
    setAttachmentUploading(true);
    setEditorError(null);
    try {
      const uploaded: ElementAttachment[] = [];
      for (const file of Array.from(files)) {
        const url = await uploadMedia(file, "image", granted);
        attachmentSeq.current += 1;
        uploaded.push({
          attachmentId: `attachment_${String(attachmentSeq.current).padStart(3, "0")}`,
          elementId: editingElementId,
          url,
          type: "image",
          filename: file.name,
          thumbnail: url,
          order: draftAttachments.length + uploaded.length,
          createdAt: new Date().toISOString(),
        });
      }
      setDraftAttachments((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setEditorError(
        e instanceof Error ? e.message : "Could not upload that file.",
      );
    } finally {
      setAttachmentUploading(false);
    }
  }

  function removeDraftAttachment(attachmentId: string) {
    setDraftAttachments((prev) =>
      prev.filter((a) => a.attachmentId !== attachmentId),
    );
  }

  function saveEditor() {
    if (!editingElementId) return;
    // Folds every sent *instruction* bubble, plus anything still sitting
    // unsent in the composer (so a typed-but-not-"sent" line isn't silently
    // dropped), into one instruction — in the order they were written.
    // Result bubbles aren't text, so they're skipped here; the latest one's
    // image is what `generatedImageUrl` below carries forward instead.
    const prompt = [
      ...draftMessages
        .filter((m): m is Extract<EditorMessage, { role: "user" }> =>
          m.role === "user",
        )
        .map((m) => m.text),
      composeText.trim(),
    ]
      .filter((t) => t.length > 0)
      .join("\n\n");
    if (!prompt) {
      setEditorError("Write at least one message before saving.");
      return;
    }
    const label = draftLabel.trim() || editingElement?.label || "Untitled";
    const now = new Date().toISOString();
    onElementsChange((prev) =>
      prev.map((e) =>
        e.elementId === editingElementId
          ? {
              ...e,
              label,
              rawPrompt: prompt,
              // Pass-through — see lib/promptCombiner.ts's doc comment.
              optimizedPrompt: prompt,
              attachments: draftAttachments,
              generatedImageUrl: lastGeneratedUrl,
              status: "completed",
              updatedAt: now,
            }
          : e,
      ),
    );
    setEditingElementId(null);
  }

  function finalize(list: ElementRecord[]) {
    if (list.length === 0) {
      onClose();
      return;
    }
    // sessionImageUrl is the one running composite every Send this session
    // built onto — see its own doc comment — so it's what buildCombinedPrompt
    // uses as the single combined reference image when anything was actually
    // AI-edited this session, instead of folding each element in separately.
    const dataset2 = buildCombinedPrompt(list, sessionImageUrl);
    onSave({
      prompt: dataset2.combinedPrompt,
      referenceImageUrls: dataset2.attachments.map((a) => a.url),
    });
  }

  // Wrapped defensively: onSave ultimately runs the parent's state update
  // and closes this modal, so if anything in that chain throws, the only
  // sign would otherwise be the modal silently staying open with the click
  // appearing to do nothing — worth surfacing instead of swallowing.
  function handleDone() {
    try {
      if (elements.length === 0) {
        onClose();
        return;
      }
      const incomplete = elements.filter((e) => e.status !== "completed");
      if (incomplete.length > 0) {
        setShowIncompleteWarning(true);
        return;
      }
      finalize(elements);
    } catch (e) {
      setError(
        e instanceof Error
          ? `Could not save: ${e.message}`
          : "Could not save these selections — try again.",
      );
    }
  }

  function continueWithoutIncomplete() {
    setShowIncompleteWarning(false);
    finalize(elements.filter((e) => e.status === "completed"));
  }

  const incompleteCount = elements.filter(
    (e) => e.status !== "completed",
  ).length;
  const completedCount = elements.length - incompleteCount;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-xl border border-ink-650 bg-ink-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">
              Select objects &amp; backgrounds
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] text-ink-400 hover:text-white"
            >
              Close
            </button>
          </div>
          <p className="truncate text-[11px] text-ink-400">
            Tap an object or describe one, press Detect, then tap{" "}
            <span className="text-accent-300">✨</span> to edit it.
          </p>

          {sessionImageUrl && (
            <div className="rounded-lg border border-accent-500/40 bg-accent-500/[0.06] p-2">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-accent-400">
                Final Edit — all edits combined
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sessionImageUrl}
                alt="Final edited result"
                className="mx-auto max-h-48 w-auto rounded-md object-contain"
              />
            </div>
          )}

          {loadingFrame && (
            <div className="flex h-48 items-center justify-center text-xs text-ink-400">
              Preparing a frame from this clip…
            </div>
          )}

          {frameDataUrl && (
            <div className="relative mx-auto max-h-[75vh] w-fit max-w-full overflow-auto rounded-lg border border-ink-650 bg-black">
              {/*
               * Tightly wraps the img (no extra width from the centering
               * flex parent above) so every absolutely-positioned child here
               * lines up with the rendered frame pixel-for-pixel, both the
               * highlight overlays below and the manual-draw pointer math in
               * fractionFromEvent, which measures this div's own rect.
               */}
              <div ref={frameBoxRef} className="relative inline-block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frameDataUrl}
                  alt=""
                  draggable={false}
                  style={
                    frameSize && frameSize.height >= frameSize.width
                      ? { height: 560, width: "auto", maxWidth: "none" }
                      : { width: "100%", height: "auto" }
                  }
                  className="block select-none"
                />
                {/*
                 * Every element stays highlighted on the frame, not just the
                 * one currently being detected — the closest a text-concept
                 * model (or a hand-drawn box) gets to a true hover/long-press
                 * highlight. Tinted with mask-image/background-color rather
                 * than mix-blend-screen so several elements read as distinct
                 * colors instead of stacking into one white blob.
                 */}
                {elements.map((el) => (
                  <div
                    key={el.elementId}
                    className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
                    style={{
                      backgroundColor: el.color,
                      WebkitMaskImage: `url(${el.maskUrl})`,
                      maskImage: `url(${el.maskUrl})`,
                      WebkitMaskSize: "contain",
                      maskSize: "contain",
                      WebkitMaskRepeat: "no-repeat",
                      maskRepeat: "no-repeat",
                      WebkitMaskPosition: "center",
                      maskPosition: "center",
                    }}
                  />
                ))}
                {pending && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pending.maskUrl}
                    alt=""
                    className="pointer-events-none absolute inset-0 h-full w-full animate-pulse object-contain opacity-70 mix-blend-screen"
                  />
                )}
                {/* The manual selection being built, across however many
                    add/subtract strokes so far — shown between strokes (the
                    in-progress single stroke itself has its own live preview
                    further below) so it's clear what the next stroke will
                    add to or carve out of. */}
                {pendingMaskUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={pendingMaskUrl}
                    alt=""
                    className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-70 mix-blend-screen"
                  />
                )}
                {segmenting && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
                    Detecting…
                  </div>
                )}
                {/*
                 * Manual draw surface — only intercepts pointer events while
                 * manualMode is on, so it doesn't swallow clicks the rest of
                 * the time. Pointer Events (not mouse/touch separately)
                 * cover both a mouse drag and a finger drag on mobile in one
                 * path.
                 */}
                {manualMode && (
                  <div
                    className="absolute inset-0 cursor-crosshair touch-none"
                    onPointerDown={startManualDraw}
                    onPointerMove={moveManualDraw}
                    onPointerUp={endManualDraw}
                    onPointerCancel={endManualDraw}
                  >
                    {drawShape === "box" &&
                      dragRect &&
                      (() => {
                        const r = normalizeRect(dragRect);
                        return (
                          <div
                            className="pointer-events-none absolute border-2 border-dashed border-accent-400 bg-accent-400/15"
                            style={{
                              left: `${r.left * 100}%`,
                              top: `${r.top * 100}%`,
                              width: `${(r.right - r.left) * 100}%`,
                              height: `${(r.bottom - r.top) * 100}%`,
                            }}
                          />
                        );
                      })()}
                    {drawShape === "pencil" && freehandPoints && (
                      // viewBox 0 0 1 1 matches the fraction coordinates
                      // points are stored in directly — no extra scaling
                      // math. vector-effect keeps the stroke a constant
                      // screen width even though the viewBox is stretched to
                      // a non-square box for a portrait/landscape frame.
                      <svg
                        className="pointer-events-none absolute inset-0 h-full w-full"
                        viewBox="0 0 1 1"
                        preserveAspectRatio="none"
                      >
                        <polygon
                          points={freehandPoints
                            .map((p) => `${p.x},${p.y}`)
                            .join(" ")}
                          fill="rgba(163,230,53,0.2)"
                          stroke="#a3e635"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {frameUrl && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setManualMode((m) => !m);
                  setDragRect(null);
                  setFreehandPoints(null);
                  resetManualSelection();
                }}
                className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition ${
                  manualMode
                    ? "border-accent-500 bg-accent-500/15 text-accent-300"
                    : "border-ink-650 bg-ink-850 text-ink-200 hover:border-ink-500"
                }`}
              >
                {manualMode
                  ? "✓ Drawing — tap again to stop"
                  : "✎ Draw a selection manually"}
              </button>
              {manualMode && (
                <>
                  <div className="flex overflow-hidden rounded-md border border-ink-650">
                    <button
                      type="button"
                      onClick={() => {
                        setDrawShape("box");
                        setFreehandPoints(null);
                      }}
                      className={`px-2.5 py-1 text-[11px] font-medium transition ${
                        drawShape === "box"
                          ? "bg-accent-500 text-accent-ink"
                          : "bg-ink-850 text-ink-300 hover:text-white"
                      }`}
                    >
                      ▭ Box
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDrawShape("pencil");
                        setDragRect(null);
                      }}
                      className={`px-2.5 py-1 text-[11px] font-medium transition ${
                        drawShape === "pencil"
                          ? "bg-accent-500 text-accent-ink"
                          : "bg-ink-850 text-ink-300 hover:text-white"
                      }`}
                    >
                      ✎ Pencil
                    </button>
                  </div>
                  {/* Which way each new box/pencil stroke combines into the
                      selection being built — see commitManualStroke's doc
                      comment. Only meaningful once there's already something
                      to add to or subtract from, but left always visible
                      (rather than only after the first stroke) so it reads
                      as "how the next stroke will behave" from the start,
                      not a control that appears out of nowhere mid-draw. */}
                  <div className="flex overflow-hidden rounded-md border border-ink-650">
                    <button
                      type="button"
                      onClick={() => setManualCombineMode("add")}
                      title="Add to selection"
                      aria-label="Add to selection"
                      className={`px-2.5 py-1 text-[11px] font-medium transition ${
                        manualCombineMode === "add"
                          ? "bg-accent-500 text-accent-ink"
                          : "bg-ink-850 text-ink-300 hover:text-white"
                      }`}
                    >
                      ⊕ Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setManualCombineMode("subtract")}
                      title="Subtract from selection"
                      aria-label="Subtract from selection"
                      className={`px-2.5 py-1 text-[11px] font-medium transition ${
                        manualCombineMode === "subtract"
                          ? "bg-accent-500 text-accent-ink"
                          : "bg-ink-850 text-ink-300 hover:text-white"
                      }`}
                    >
                      ⊖ Subtract
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {pendingMaskUrl && (
            <div className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/[0.08] px-3 py-2">
              <input
                type="text"
                autoFocus
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmManualSelection();
                  if (e.key === "Escape") {
                    resetManualSelection();
                    setManualName("");
                  }
                }}
                placeholder="Name this selection, e.g. “the grapefruit” — or keep drawing to add/subtract more first"
                className="flex-1 rounded-md border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
              />
              <button
                type="button"
                onClick={confirmManualSelection}
                disabled={!manualName.trim()}
                className="shrink-0 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  resetManualSelection();
                  setManualName("");
                }}
                className="shrink-0 text-xs text-ink-400 hover:text-white"
              >
                Cancel
              </button>
            </div>
          )}

          {frameUrl && (loadingCandidates || candidates.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {loadingCandidates && candidates.length === 0 && (
                <span className="text-[11px] text-ink-500">
                  Finding objects…
                </span>
              )}
              {candidates.map((label) => {
                const el = elementForLabel(label);
                const busy = pillBusy === label;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => void addByLabel(label)}
                    disabled={busy}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:cursor-wait disabled:opacity-60 ${
                      el
                        ? "border-transparent text-white"
                        : "border-ink-650 bg-ink-850 text-ink-200 hover:border-ink-500"
                    }`}
                    style={
                      el ? { backgroundColor: `${el.color}33` } : undefined
                    }
                  >
                    {el && (
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: el.color }}
                        aria-hidden
                      />
                    )}
                    {busy ? "Detecting…" : label}
                  </button>
                );
              })}
            </div>
          )}

          {!pending && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={describeText}
                onChange={(e) => setDescribeText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleDetect();
                }}
                placeholder="What do you want to select? e.g. “the dog”"
                disabled={!frameUrl || segmenting}
                className="flex-1 rounded-md border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void handleDetect()}
                disabled={!frameUrl || !describeText.trim() || segmenting}
                className="shrink-0 rounded-md bg-accent-500 px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
              >
                Detect
              </button>
            </div>
          )}

          {pending && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-accent-500/30 bg-accent-500/[0.08] px-3 py-2">
              <span className="text-xs text-ink-200">
                Found <span className="text-white">“{pending.name}”</span> —
                keep it?
              </span>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={keepPending}
                  className="rounded-md bg-accent-500 px-2.5 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-400"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="text-xs text-ink-400 hover:text-white"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {elements.length > 0 && (
            <ul className="space-y-1.5">
              {elements.map((el) => (
                <li
                  key={el.elementId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-ink-650 bg-ink-850 px-3 py-1.5 text-xs text-ink-200"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: el.color }}
                      aria-hidden
                    />
                    <span
                      className={
                        el.status === "completed"
                          ? "shrink-0 text-accent-400"
                          : "shrink-0 text-ink-500"
                      }
                      aria-hidden
                    >
                      {el.status === "completed" ? "✓" : "○"}
                    </span>
                    <span className="truncate">{el.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2.5">
                    <button
                      type="button"
                      onClick={() => openEditor(el)}
                      className="text-ink-400 hover:text-white"
                      title="Write an edit instruction"
                      aria-label={`Edit instruction for ${el.label}`}
                    >
                      ✨
                    </button>
                    <button
                      type="button"
                      onClick={() => removeElement(el.elementId)}
                      className="text-ink-400 hover:text-white"
                      aria-label={`Remove ${el.label}`}
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={handleDone}
            className="w-full rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-400"
          >
            {elements.length > 0
              ? `Done — ${completedCount}/${elements.length} ready`
              : "Done"}
          </button>
        </div>
      </div>

      {editingElement &&
        (() => {
          const hasContent =
            draftMessages.length > 0 || composeText.trim().length > 0;
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
              <div className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl border border-ink-650 bg-ink-900 p-4">
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    placeholder="Label"
                    aria-label="Element label"
                    className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1 py-1 text-sm font-semibold text-white outline-none focus:border-ink-650 focus:bg-ink-850"
                  />
                  <div className="flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void regenerateSelection()}
                      disabled={regenerating}
                      title="Regenerate this selection"
                      aria-label="Regenerate this selection"
                      className="text-ink-400 hover:text-white disabled:cursor-wait disabled:opacity-50"
                    >
                      {regenerating ? "…" : "↻"}
                    </button>
                    <button
                      type="button"
                      onClick={removeEditingElement}
                      title="Remove this element"
                      aria-label="Remove this element"
                      className="text-ink-400 hover:text-red-400"
                    >
                      🗑
                    </button>
                    <button
                      type="button"
                      onClick={closeEditor}
                      className="text-[11px] text-ink-400 hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/*
                 * A running chat about this one element: it opens with the
                 * highlighted crop already "attached" as the first bubble
                 * (exactly what's selected, shown the way it'd look pinned
                 * in a ChatGPT-style thread), then every instruction typed
                 * — past and new — appears below it as its own message.
                 * There's no reply bubble because nothing here calls a
                 * model yet (see lib/promptCombiner.ts); regenerating or
                 * saving both read straight out of this same thread.
                 */}
                <div className="flex max-h-[42vh] flex-col gap-2 overflow-y-auto rounded-lg border border-ink-650 bg-black/40 p-2.5">
                  {frameDataUrl && (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] overflow-hidden rounded-xl rounded-tr-sm border border-ink-650 bg-ink-850">
                        <div className="relative flex max-h-56 items-center justify-center bg-black">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={frameDataUrl}
                            alt=""
                            className="block max-h-56 w-auto max-w-full object-contain"
                          />
                          <div
                            className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
                            style={{
                              backgroundColor: editingElement.color,
                              WebkitMaskImage: `url(${editingElement.maskUrl})`,
                              maskImage: `url(${editingElement.maskUrl})`,
                              WebkitMaskSize: "contain",
                              maskSize: "contain",
                              WebkitMaskRepeat: "no-repeat",
                              maskRepeat: "no-repeat",
                              WebkitMaskPosition: "center",
                              maskPosition: "center",
                            }}
                          />
                        </div>
                        <p className="px-2.5 py-1.5 text-[10px] text-ink-400">
                          Attached — the highlighted selection
                        </p>
                      </div>
                    </div>
                  )}

                  {draftMessages.map((m) => {
                    if (m.role === "user") {
                      return (
                        <div key={m.id} className="flex justify-end">
                          <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-tr-sm bg-accent-500/15 px-3 py-2 text-xs text-white">
                            {m.text}
                          </div>
                        </div>
                      );
                    }
                    if (m.role === "note") {
                      return (
                        <p
                          key={m.id}
                          className="text-center text-[10px] text-ink-500"
                        >
                          {m.text}
                        </p>
                      );
                    }
                    // role === "result" — the actual edited frame, shown
                    // left-aligned like a reply, the way the thread tells
                    // apart "what I asked for" from "what came back".
                    return (
                      <div key={m.id} className="flex justify-start">
                        <div className="max-w-[85%] overflow-hidden rounded-xl rounded-tl-sm border border-ink-650 bg-ink-850">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={m.imageUrl}
                            alt=""
                            className="block max-h-56 w-auto max-w-full object-contain"
                          />
                          <p className="px-2.5 py-1.5 text-[10px] text-ink-400">
                            {m.mock
                              ? "Mock result — no real edit applied"
                              : "Generated"}
                          </p>
                        </div>
                      </div>
                    );
                  })}

                  {generating && (
                    <div className="flex justify-start">
                      <div className="rounded-xl rounded-tl-sm border border-ink-650 bg-ink-850 px-3 py-2 text-xs text-ink-400">
                        Generating…
                      </div>
                    </div>
                  )}

                  {draftAttachments.length > 0 && (
                    <div className="flex justify-end">
                      <ul className="flex max-w-[85%] flex-wrap justify-end gap-2">
                        {draftAttachments.map((a) => (
                          <li
                            key={a.attachmentId}
                            className="relative h-14 w-14 overflow-hidden rounded-md border border-ink-650 bg-ink-850"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={a.thumbnail}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                removeDraftAttachment(a.attachmentId)
                              }
                              className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/70 text-[10px] text-white hover:bg-black"
                              aria-label="Remove attachment"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div className="flex items-end gap-2">
                  <textarea
                    value={composeText}
                    onChange={(e) => setComposeText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendComposedMessage();
                      }
                    }}
                    rows={2}
                    placeholder='e.g. "Replace this with a different version — keep the same scale, lighting, and shadow direction as the rest of the scene."'
                    className="flex-1 resize-y rounded-md border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
                  />
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <label
                      className="cursor-pointer rounded-md border border-ink-650 bg-ink-850 px-2.5 py-1.5 text-center text-[11px] text-ink-200 hover:border-ink-500"
                      title="Attach reference images"
                    >
                      {attachmentUploading ? "…" : "📎"}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        disabled={attachmentUploading}
                        onChange={(e) => {
                          void handleAttachmentFiles(e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void sendComposedMessage()}
                      disabled={!composeText.trim() || generating}
                      className="rounded-md bg-accent-500 px-2.5 py-1.5 text-[11px] font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
                    >
                      {generating ? "…" : "Send"}
                    </button>
                  </div>
                </div>
                <p className="-mt-1.5 text-[10px] text-ink-500">
                  Enter to send, Shift+Enter for a new line. Send actually
                  generates this edit — everything outside the highlight
                  stays untouched, and it builds on top of any other
                  element you&apos;ve already edited here, so editing
                  several elements lands as one combined image (labeled
                  Mock if mock mode is on), not a separate image per
                  element. ↻ instead moves the highlighted area itself,
                  without generating anything. 📎 attaches extra reference
                  images, described in your own words for now rather than
                  sent to the model directly.
                </p>

                {editorError && (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {editorError}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeEditor}
                    className="flex-1 rounded-xl border border-ink-650 px-4 py-2.5 text-sm font-medium text-ink-300 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveEditor}
                    disabled={!hasContent}
                    className="flex-1 rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {showIncompleteWarning && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-xl border border-ink-650 bg-ink-900 p-4">
            <p className="text-sm text-white">
              {incompleteCount === 1
                ? "1 selected element has no editing instruction."
                : `${incompleteCount} selected elements have no editing instruction.`}
            </p>
            <p className="mt-1 text-xs text-ink-400">
              Continue without it, or go back and add one?
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setShowIncompleteWarning(false)}
                className="flex-1 rounded-xl border border-ink-650 px-4 py-2.5 text-sm font-medium text-ink-300 hover:text-white"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={continueWithoutIncomplete}
                className="flex-1 rounded-xl bg-accent-500 px-4 py-2.5 text-sm font-semibold text-accent-ink hover:bg-accent-400"
              >
                Continue without it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
