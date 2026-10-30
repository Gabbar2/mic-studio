"use client";

import { useCallback, useRef, useState } from "react";
import TrimTimeline from "./TrimTimeline";
import SceneObjectSelector from "./SceneObjectSelector";
import ConsentCheckbox, {
  UploadConsentProvider,
  useUploadConsent,
} from "@/components/UploadConsent";
import { uploadMedia } from "@/lib/upload";
import { extractClip, planScenesFromCuts } from "@/lib/videoClip";
import { detectSceneCuts } from "@/lib/sceneDetect";
import { captureThumbnail } from "@/lib/videoThumbnail";
import { loadFfmpeg } from "@/lib/ffmpegLoader";
import {
  writeReferenceTransfer,
  type ReferenceTransferJob,
} from "@/lib/referenceTransfer";
import type { ElementRecord } from "@/lib/promptCombiner";
import { extractYouTubeVideoId, type YouTubeLicense } from "@/lib/youtube";

/**
 * Sites that hand out real, directly-linkable video files — unlike YouTube,
 * pasting one of these straight into the URL field just works, no license
 * gate needed, because that's what these sites are built for. Shown as
 * their own expand-a-search-field buttons next to "Paste YouTube URL",
 * since a YouTube link search only ever ends in "now go download it
 * elsewhere" (see the YouTube panel below) while these end in "paste the
 * link, done".
 */
const FOOTAGE_SITES = [
  {
    key: "pexels",
    label: "Pexels",
    searchUrl: (q: string) =>
      `https://www.pexels.com/search/videos/${encodeURIComponent(q)}/`,
  },
  {
    key: "pixabay",
    label: "Pixabay",
    searchUrl: (q: string) =>
      `https://pixabay.com/videos/search/${encodeURIComponent(q)}/`,
  },
] as const;
import {
  MODELS,
  getModel,
  durationsFor,
  qualitiesFor,
  resolutionFor,
  referenceVideoCapSeconds,
  type AspectRatio,
} from "@/lib/models";

const REFERENCE_MODELS = MODELS.filter((m) => m.supportsReferenceVideo);

interface SourceMeta {
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number | null;
  name: string;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "unknown size";
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function guessAspectRatio(width: number, height: number): AspectRatio {
  const r = width / height;
  if (r > 1.2) return "16:9";
  if (r < 0.83) return "9:16";
  return "1:1";
}

type Stage = "empty" | "loaded" | "preparing" | "ready";

/**
 * An extra still frame grabbed from the trim timeline's "Take Snap" button
 * — a quick way to pull a second (or third…) specific frame out of a clip
 * to run through its own "Select objects & backgrounds" pass, without
 * re-trimming and re-encoding a whole new clip just to get one still. Not a
 * destination of its own: whatever gets edited on a snap is folded onto its
 * parent clip's own job (prompt + image references) once saved — see
 * saveSnapPrompt — so a clip can end up with references from its own
 * auto-captured frame AND from one or more snaps, all combined.
 */
interface SnapRecord {
  id: string;
  /** Where in the source clip this was taken from — drives the 📍 marker
   * TrimTimeline draws on the track for it. */
  atSeconds: number;
  frameDataUrl: string;
  frameWidth: number;
  frameHeight: number;
  /** Dataset 1 for this snap's own multi-element editing — same shape and
   * same reason it lives outside SceneObjectSelector as PreparedClip's own
   * `elements` field (see below). */
  elements: ElementRecord[];
  /** True once this snap's edits have been folded onto its parent clip's
   * job via saveSnapPrompt. A snap that was only ever taken — never opened
   * in "Select objects" — stays false forever, which is how
   * continueInStudio (below) knows it still needs to upload that snap's
   * raw frameDataUrl and append it as its own reference, rather than
   * assuming every snap already made it into referenceImageUrls. */
  mergedIntoClip: boolean;
}

interface PreparedClip {
  job: ReferenceTransferJob;
  start: number;
  end: number;
  thumbnail: string | null;
  /**
   * Dataset 1 for this clip's multi-element editing — lives here, not as
   * local state inside SceneObjectSelector, specifically so it survives
   * that modal unmounting when the user closes and reopens it for the same
   * clip. In-memory only (no backing table): cleared on a full page reload,
   * same lifetime as everything else in this editor.
   */
  elements: ElementRecord[];
  /** Extra frames grabbed via "Take Snap" while this clip was the most
   * recently prepared one — see SnapRecord above. */
  snaps: SnapRecord[];
}

export default function ReferenceEditor() {
  return (
    <UploadConsentProvider>
      <ReferenceEditorInner />
    </UploadConsentProvider>
  );
}

function ReferenceEditorInner() {
  const { granted } = useUploadConsent();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // A plain incrementing counter rather than Date.now()/crypto.randomUUID() —
  // both read impure/nondeterministic sources the lint rules for component
  // purity flag even from inside an event handler defined in the component
  // body. A ref mutated only in response to a click is exactly what refs are
  // for.
  const jobSeq = useRef(0);
  const snapSeq = useRef(0);

  const [stage, setStage] = useState<Stage>("empty");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string>("");
  const [meta, setMeta] = useState<SourceMeta | null>(null);
  const [modelId, setModelId] = useState(REFERENCE_MODELS[0]?.id ?? "");
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepareLabel, setPrepareLabel] = useState("");
  const [prepareProgress, setPrepareProgress] = useState(0);
  const [clips, setClips] = useState<PreparedClip[]>([]);
  // Which prepared scene clips are checked to go on to Studio — keyed by
  // job id rather than index, so it survives clips being added one at a
  // time as detection/trimming works through the list. Absence of a key
  // means "included": a clip is on by default the moment it appears, with
  // no flash of being unchecked first.
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  // Which clip's object/background selector is open — null when closed.
  // Only one at a time; the selector is a full-screen modal.
  const [selectorClipId, setSelectorClipId] = useState<string | null>(null);
  // Same idea, one level down — which snap's own selector is open. Separate
  // from selectorClipId rather than a union of the two, since a clip's own
  // selector and one of its snaps' selectors are opened from different UI
  // (the "Select objects →" button vs. a snap thumbnail) and saved through
  // different paths (savePromptForClip replaces the job's prompt/refs;
  // saveSnapPrompt merges onto whatever's already there — see both below).
  const [selectorSnap, setSelectorSnap] = useState<{
    clipId: string;
    snapId: string;
  } | null>(null);
  // True from the moment "Continue in Mic Studio" is clicked until the
  // browser actually navigates away (or the handoff fails) — guards against
  // a second click re-running the upload-and-navigate work (and, since
  // clicking again mid-navigation did nothing visible before, made it look
  // like the first click hadn't registered).
  const [navigatingToStudio, setNavigatingToStudio] = useState(false);

  // A pasted YouTube link never loads as a direct video regardless of its
  // license — YouTube blocks that outside its own player — so instead of
  // letting it fail with the generic playback error, this checks the
  // video's declared license first and explains whether it's even legally
  // reusable, then disables the field either way (see handleUrlSubmit).
  const [checkingLicense, setCheckingLicense] = useState(false);
  const [licenseNotice, setLicenseNotice] = useState<{
    license: YouTubeLicense;
    message: string;
  } | null>(null);
  const [urlFieldBlocked, setUrlFieldBlocked] = useState(false);
  // Reused for whichever footage-site panel (Pexels, Pixabay, …) is
  // currently open — only one can be open at a time, so one field is
  // enough rather than one per site.
  const [siteQuery, setSiteQuery] = useState("");
  // True once the person has clicked "Go ↗" and actually been sent to the
  // open footage-site panel's site — the "Downloaded it? Upload the file"
  // button below the search box only appears then, since there's nothing to
  // upload until they've been there and downloaded a clip.
  const [siteVisited, setSiteVisited] = useState(false);
  // The empty-state media box starts on a row of buttons — Choose a video,
  // Paste YouTube URL, one per FOOTAGE_SITES entry — and swaps to whichever
  // one was clicked, hiding the buttons in favor of that one expanded
  // field. "← Back" returns to the button row and clears whatever was in
  // progress.
  const [mediaInputMode, setMediaInputMode] = useState<
    "buttons" | "paste" | (typeof FOOTAGE_SITES)[number]["key"]
  >("buttons");

  const model = getModel(modelId) ?? REFERENCE_MODELS[0];
  const capSeconds = model ? referenceVideoCapSeconds(model) : 0;

  const loadSource = useCallback((file: File | null, remoteUrl: string) => {
    setError(null);
    setClips([]);
    setIncluded({});
    setStage("empty");
    setSourceFile(file);

    const objectUrl = file ? URL.createObjectURL(file) : remoteUrl;
    setSourceUrl(objectUrl);

    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.crossOrigin = "anonymous";
    probe.onloadedmetadata = () => {
      const durationSeconds = probe.duration;
      const next: SourceMeta = {
        durationSeconds,
        width: probe.videoWidth,
        height: probe.videoHeight,
        sizeBytes: file?.size ?? null,
        name: file?.name ?? remoteUrl,
      };
      setMeta(next);
      setRange({ start: 0, end: durationSeconds });
      setStage("loaded");
    };
    probe.onerror = () => {
      setError(
        "Could not read that video. If it's a pasted URL, the host may be blocking playback here — try uploading the file instead.",
      );
    };
    probe.src = objectUrl;
  }, []);

  /**
   * Routes a pasted URL to the right path before touching the video
   * element at all. A YouTube link skips loadSource entirely — it would
   * only fail there with a generic error — and instead gets checked
   * against YouTube's own declared license via /api/youtube-license:
   *  - Creative Commons: told they're free to reuse it, but still pointed
   *    at downloading it through a legitimate route and using "Choose a
   *    video" — a CC license is permission to reuse, not a technical
   *    download path this app (or YouTube itself) provides.
   *  - Standard license, or unreadable (private/deleted/lookup failed):
   *    told plainly they likely don't have the right to reuse it.
   * Either way the field is disabled afterward — a YouTube link can never
   * proceed through this field, only the specific guidance differs. Any
   * other URL (a direct video file) goes through loadSource exactly as
   * before this check existed.
   */
  async function handleUrlSubmit(url: string) {
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      loadSource(null, url);
      return;
    }

    setError(null);
    setLicenseNotice(null);
    setCheckingLicense(true);
    try {
      const res = await fetch("/api/youtube-license", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const json = (await res.json()) as {
        license?: YouTubeLicense;
        error?: string;
      };
      if (!res.ok || !json.license) {
        throw new Error(json.error ?? "Could not check that video's license.");
      }

      const message =
        json.license === "creativeCommon"
          ? "This video is marked Creative Commons — you're free to reuse it. YouTube still won't let this app load it directly, though: download it through YouTube's own download option (if the creator enabled it) or another legitimate source, then use “Choose a video” above."
          : "This video has a standard YouTube license (or its license couldn't be confirmed), so you likely don't have the right to reuse it. This app won't process a YouTube link either way — paste or upload a video you have the rights to use instead.";

      setLicenseNotice({ license: json.license, message });
      setUrlFieldBlocked(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not check that video's license.",
      );
    } finally {
      setCheckingLicense(false);
    }
  }

  function resetUrlField() {
    setLicenseNotice(null);
    setUrlFieldBlocked(false);
    setError(null);
    if (urlInputRef.current) urlInputRef.current.value = "";
  }

  function backToMediaButtons() {
    resetUrlField();
    setSiteQuery("");
    setSiteVisited(false);
    setMediaInputMode("buttons");
  }

  async function handlePrepare() {
    if (!model || !meta || !sourceUrl) return;
    if (!granted) {
      setError("Tick the confirmation above first.");
      return;
    }

    // Deliberately does NOT clear `clips`/`included` here — this can run
    // again after a person has already prepared one selection (they adjust
    // the trim range and hit "Prepare clip(s)" again to add more scenes),
    // and wiping the list on every run would silently throw away clips they
    // already reviewed and kept. Each run's new clips are appended below
    // instead. "Replace video" (above) is the one place that still clears
    // everything, since that's swapping the source entirely.
    setStage("preparing");
    setError(null);
    // Tracked separately from the `clips` state (which this closure can
    // only see as of the render that started this run) so the catch below
    // knows whether THIS run added anything before failing, even if
    // `clips` itself was still empty when the run began.
    let addedThisRun = 0;

    try {
      // Remote URLs need their actual bytes for ffmpeg — a local File
      // already has them. Done only now, not when the URL was first pasted,
      // so a person previewing several candidate clips isn't downloading
      // every one of them in full before picking one.
      const sourceBlob: Blob = sourceFile
        ? sourceFile
        : await (async () => {
            setPrepareLabel("Fetching source video…");
            const res = await fetch(sourceUrl);
            if (!res.ok) {
              throw new Error(
                "Could not download that URL from here — the host may be blocking cross-site requests. Try uploading the file instead.",
              );
            }
            return res.blob();
          })();

      // Loaded explicitly, up front, and labeled on its own — a ~30 MB
      // engine download the first time it's used is a different kind of
      // wait than the encode that follows, and showing one spinner for both
      // made a slow-but-fine download look like a stuck encode (see the
      // console logs this now also prints — open DevTools if this step ever
      // needs diagnosing again). Already cached after the first clip, so
      // this resolves instantly for every segment after the first.
      setPrepareLabel("Loading the trimming engine (first time only)…");
      await loadFfmpeg();

      // Scene detection runs on the already-selected range only, not the
      // whole upload — the person drew that range on purpose, and scanning
      // past it would both waste time and could pull in cuts they deliberately
      // trimmed away.
      setPrepareLabel("Finding scenes in your selection…");
      setPrepareProgress(0);
      const cuts = await detectSceneCuts(
        sourceBlob,
        range.start,
        range.end,
        0.35,
        setPrepareProgress,
      );

      const segments = planScenesFromCuts(
        cuts,
        range.start,
        range.end,
        capSeconds || Infinity,
      );
      const aspectRatio = guessAspectRatio(meta.width, meta.height);

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        setPrepareLabel(
          segments.length > 1
            ? `Trimming scene ${i + 1} of ${segments.length}…`
            : "Trimming your clip…",
        );
        setPrepareProgress(0);

        const clipBlob = await extractClip(
          sourceBlob,
          seg.start,
          seg.end,
          setPrepareProgress,
        );

        setPrepareLabel(
          segments.length > 1
            ? `Uploading scene ${i + 1} of ${segments.length}…`
            : "Uploading your clip…",
        );
        jobSeq.current += 1;
        const file = new File(
          [clipBlob],
          `reference-${jobSeq.current}-${i + 1}.mp4`,
          { type: "video/mp4" },
        );
        const url = await uploadMedia(file, "video", granted);

        const job: ReferenceTransferJob = {
          id: `job-${jobSeq.current}`,
          modelId: model.id,
          referenceVideoUrl: url,
          referenceVideoDurationSeconds: seg.end - seg.start,
          referenceImageUrls: [],
          prompt: "",
          aspectRatio,
        };

        // Best-effort — a missing thumbnail just renders an empty tile
        // rather than failing the whole prepare flow (see videoThumbnail.ts).
        const thumbnail = await captureThumbnail(
          sourceUrl,
          (seg.start + seg.end) / 2,
        );

        // Appended onto whatever was already prepared — not replaced — so
        // running this again after an earlier run keeps those clips. Shown
        // as each one finishes rather than all at once at the end — there
        // can now be several scenes, and watching them land one by one is a
        // better signal of real progress than a single spinner that doesn't
        // move until the whole batch is done.
        setClips((prev) => [
          ...prev,
          {
            job,
            start: seg.start,
            end: seg.end,
            thumbnail,
            elements: [],
            snaps: [],
          },
        ]);
        setIncluded((prev) => ({ ...prev, [job.id]: true }));
        addedThisRun += 1;
      }

      setStage("ready");
    } catch (e) {
      // Logged in full, not just whatever string ends up on screen — some
      // failures here (a Worker 'error' event, say) reject with something
      // that isn't a standard Error, so the banner falls back to a generic
      // message and this is the only place the real shape of what was
      // thrown is visible at all.
      console.error("[reference-editor] prepare failed:", e);
      setError(e instanceof Error ? e.message : "Could not prepare the clip.");
      // "ready" (not "loaded") whenever there's something to show — either
      // clips already sitting there from an earlier run, or ones this run
      // itself managed to add before hitting the error — so a failure
      // partway through a second run doesn't hide clips already reviewed
      // and kept.
      setStage(clips.length > 0 || addedThisRun > 0 ? "ready" : "loaded");
    }
  }

  const selectedJobs = clips
    .filter((c) => included[c.job.id] !== false)
    .map((c) => c.job);

  const selectorClip = clips.find((c) => c.job.id === selectorClipId) ?? null;

  function savePromptForClip(
    clipId: string,
    result: { prompt: string; referenceImageUrls: string[] },
  ) {
    setClips((prev) =>
      prev.map((c) =>
        c.job.id === clipId
          ? {
              ...c,
              job: {
                ...c.job,
                prompt: result.prompt,
                referenceImageUrls: result.referenceImageUrls,
              },
            }
          : c,
      ),
    );
    setSelectorClipId(null);
  }

  /** Dataset 1 updater for whichever clip's selector is currently open —
   * passed down as SceneObjectSelector's `onElementsChange` so that
   * component can treat its element list as a normal piece of state (via
   * the updater-function form of setState) without knowing it's actually
   * stored per-clip up here. */
  function setClipElements(
    clipId: string,
    updater: (prev: ElementRecord[]) => ElementRecord[],
  ) {
    setClips((prev) =>
      prev.map((c) =>
        c.job.id === clipId ? { ...c, elements: updater(c.elements) } : c,
      ),
    );
  }

  /**
   * "Take Snap" on the trim timeline hands back a freshly captured JPEG
   * data URL — this turns it into a SnapRecord and attaches it to whichever
   * clip was prepared most recently (clips[clips.length - 1]), since that's
   * "the selected clip" in the normal one-clip-at-a-time flow this was
   * built for; TrimTimeline itself only offers the button once clips.length
   * > 0 (see canTakeSnap below), so this should never fire with an empty
   * list, but the guard is cheap insurance against the button briefly being
   * stale mid-render. Decoding the data URL here (rather than asking
   * TrimTimeline for pixel dimensions) means TrimTimeline doesn't need to
   * know anything about SceneObjectSelector's frameWidth/frameHeight needs.
   */
  function handleTakeSnap(dataUrl: string, atSeconds: number) {
    if (clips.length === 0) return;
    const targetClipId = clips[clips.length - 1].job.id;
    const img = new Image();
    img.onload = () => {
      snapSeq.current += 1;
      const snap: SnapRecord = {
        id: `snap-${snapSeq.current}`,
        atSeconds,
        frameDataUrl: dataUrl,
        frameWidth: img.naturalWidth || 960,
        frameHeight: img.naturalHeight || 540,
        elements: [],
        mergedIntoClip: false,
      };
      setClips((prev) =>
        prev.map((c) =>
          c.job.id === targetClipId ? { ...c, snaps: [...c.snaps, snap] } : c,
        ),
      );
    };
    img.src = dataUrl;
  }

  // Whichever clip "Take Snap" attaches new snaps to, and the trim handles
  // lock against once it exists — always the most recently prepared one,
  // matching the normal one-clip-at-a-time flow this was built for. Once a
  // clip has been prepared, the trim range stays locked for good: this app
  // doesn't offer a way to unlock it again (see TrimTimeline — no "adjust
  // range" control), so a later clip's own range always comes from a fresh
  // trim before its own Prepare run, not a reopened one.
  const activeClip = clips.length > 0 ? clips[clips.length - 1] : null;
  const trimLocked = clips.length > 0;
  const activeClipSnapSeconds = activeClip
    ? activeClip.snaps.map((s) => s.atSeconds)
    : [];

  const selectorSnapClip = selectorSnap
    ? (clips.find((c) => c.job.id === selectorSnap.clipId) ?? null)
    : null;
  const selectorSnapRecord =
    selectorSnapClip?.snaps.find((s) => s.id === selectorSnap?.snapId) ??
    null;

  /** Dataset 1 updater for whichever snap's selector is currently open —
   * same role as setClipElements above, one level down. */
  function setSnapElements(
    clipId: string,
    snapId: string,
    updater: (prev: ElementRecord[]) => ElementRecord[],
  ) {
    setClips((prev) =>
      prev.map((c) =>
        c.job.id === clipId
          ? {
              ...c,
              snaps: c.snaps.map((s) =>
                s.id === snapId ? { ...s, elements: updater(s.elements) } : s,
              ),
            }
          : c,
      ),
    );
  }

  /**
   * A snap isn't its own destination (see SnapRecord's doc comment) — Save
   * here folds its Dataset 2 onto the parent clip's existing job instead of
   * replacing it the way savePromptForClip does for the clip's own
   * selector: image references are appended (capped at the current model's
   * own reference limit, so stacking several snaps' edits onto one clip
   * can't silently produce more slots than Mic Studio actually has), and
   * the prompt text is appended as a further paragraph so the snap's own
   * instructions aren't lost.
   */
  function saveSnapPrompt(
    clipId: string,
    snapId: string,
    result: { prompt: string; referenceImageUrls: string[] },
  ) {
    setClips((prev) =>
      prev.map((c) => {
        if (c.job.id !== clipId) return c;
        const mergedImageUrls = [
          ...c.job.referenceImageUrls,
          ...result.referenceImageUrls,
        ].slice(0, model.maxReferences);
        const mergedPrompt = [c.job.prompt, result.prompt]
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
          .join("\n\n");
        return {
          ...c,
          job: {
            ...c.job,
            referenceImageUrls: mergedImageUrls,
            prompt: mergedPrompt,
          },
          snaps: c.snaps.map((s) =>
            s.id === snapId ? { ...s, mergedIntoClip: true } : s,
          ),
        };
      }),
    );
    setSelectorSnap(null);
  }

  /**
   * Besides the edited snaps saveSnapPrompt already folds in, a snap that
   * was only ever taken — never opened in "Select objects", so
   * mergedIntoClip is still false — has nothing in referenceImageUrls yet:
   * its only record is the raw frameDataUrl sitting in memory. This uploads
   * each such snap's frame (same uploadMedia path a clip's own trimmed
   * video goes through) and appends the resulting URL, capped at the
   * model's own reference limit just like saveSnapPrompt does, so every
   * snap taken — edited or not — ends up as a reference once the user
   * continues to Studio.
   */
  async function appendUnmergedSnaps(
    job: ReferenceTransferJob,
    snaps: SnapRecord[],
  ): Promise<ReferenceTransferJob> {
    const unmerged = snaps.filter((s) => !s.mergedIntoClip);
    if (unmerged.length === 0) return job;
    const uploaded: string[] = [];
    for (const s of unmerged) {
      try {
        const blob = await (await fetch(s.frameDataUrl)).blob();
        const file = new File([blob], `${s.id}.jpg`, { type: "image/jpeg" });
        const url = await uploadMedia(file, "image", granted);
        uploaded.push(url);
      } catch {
        // Best-effort — one snap failing to upload shouldn't block the
        // rest of the handoff to Studio.
      }
    }
    if (uploaded.length === 0) return job;
    return {
      ...job,
      referenceImageUrls: [...job.referenceImageUrls, ...uploaded].slice(
        0,
        model.maxReferences,
      ),
    };
  }

  async function continueInStudio() {
    if (selectedJobs.length === 0 || navigatingToStudio) return;
    setNavigatingToStudio(true);
    setError(null);
    try {
      const finalJobs = await Promise.all(
        clips
          .filter((c) => included[c.job.id] !== false)
          .map((c) => appendUnmergedSnaps(c.job, c.snaps)),
      );
      writeReferenceTransfer(finalJobs);
      // A full browser navigation, not router.push — Studio's mount effect
      // (the one that reads the prepared clips back out of sessionStorage)
      // only ever runs once, on mount. If Studio was already visited earlier
      // in this tab this session, Next's client-side router can reuse its
      // cached render of that page instead of remounting it, which means that
      // effect never fires again and the just-written transfer sits unread —
      // landing on a stale Studio page with none of these clips loaded. A
      // real navigation guarantees a fresh mount every time, at the cost of
      // a full page reload for what's a one-time hop between two different
      // parts of the app anyway.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate: see comment above
      window.location.href = "/studio";
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not continue to Mic Studio.",
      );
      setNavigatingToStudio(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">
          Reference Editor
        </h1>
        <p className="mt-1 text-sm text-ink-400">
          Trim a source clip down to a real reference video, sized to fit
          whichever model you&apos;ll generate with, then send it straight
          into Mic Studio.
        </p>
      </div>

      {/* --- 1. Media input --------------------------------------------- */}
      {stage === "empty" && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) loadSource(file, "");
          }}
          onPaste={(e) => {
            const file = Array.from(e.clipboardData?.files ?? [])[0];
            if (file) {
              e.preventDefault();
              loadSource(file, "");
            }
          }}
          className={`flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed transition ${
            dragging
              ? "border-accent-400 bg-accent-500/20"
              : "border-accent-500/35 bg-ink-850 hover:border-accent-500/70"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) loadSource(file, "");
              e.target.value = "";
            }}
          />

          {mediaInputMode === "buttons" && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-400"
              >
                Choose a video
              </button>
              <p className="text-xs text-ink-400">or drag & drop, or paste</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setMediaInputMode("paste")}
                  className="rounded-lg bg-accent-500 px-3.5 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-400"
                >
                  Paste YouTube URL
                </button>
                {FOOTAGE_SITES.map((site) => (
                  <button
                    key={site.key}
                    type="button"
                    onClick={() => {
                      setSiteVisited(false);
                      setMediaInputMode(site.key);
                    }}
                    className="rounded-lg bg-accent-500 px-3.5 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-400"
                  >
                    {site.label} ›
                  </button>
                ))}
              </div>
            </>
          )}

          {mediaInputMode === "paste" && (
            <div className="flex w-full max-w-sm flex-col gap-1.5 px-4">
              <button
                type="button"
                onClick={backToMediaButtons}
                className="self-start text-[11px] text-ink-400 underline underline-offset-2 hover:text-white"
              >
                ← Back
              </button>
              <div className="flex items-center gap-2">
                <input
                  ref={urlInputRef}
                  type="url"
                  autoFocus
                  placeholder="paste a YouTube URL"
                  disabled={urlFieldBlocked || checkingLicense}
                  className="w-full rounded-lg border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500 disabled:opacity-50"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const url = urlInputRef.current?.value.trim();
                      if (url) void handleUrlSubmit(url);
                    }
                  }}
                />
                {urlFieldBlocked ? (
                  <button
                    type="button"
                    onClick={resetUrlField}
                    className="shrink-0 text-[11px] text-ink-400 underline underline-offset-2 hover:text-white"
                  >
                    Clear
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={checkingLicense}
                    onClick={() => {
                      const url = urlInputRef.current?.value.trim();
                      if (url) void handleUrlSubmit(url);
                    }}
                    className="shrink-0 rounded-lg bg-accent-500 px-2.5 py-1.5 text-[11px] font-semibold text-accent-ink hover:bg-accent-400 disabled:cursor-wait disabled:opacity-60"
                  >
                    Go
                  </button>
                )}
              </div>

              {checkingLicense && (
                <p className="text-[11px] text-ink-400">
                  Checking this video&apos;s license…
                </p>
              )}

              {licenseNotice && (
                <p
                  className={`rounded-lg border px-2.5 py-2 text-[11px] leading-relaxed ${
                    licenseNotice.license === "creativeCommon"
                      ? "border-accent-500/30 bg-accent-500/[0.08] text-ink-200"
                      : "border-red-500/30 bg-red-500/10 text-red-300"
                  }`}
                >
                  {licenseNotice.message}
                </p>
              )}
            </div>
          )}

          {FOOTAGE_SITES.map(
            (site) =>
              mediaInputMode === site.key && (
                <div
                  key={site.key}
                  className="flex w-full max-w-sm flex-col gap-1.5 px-4"
                >
                  <button
                    type="button"
                    onClick={backToMediaButtons}
                    className="self-start text-[11px] text-ink-400 underline underline-offset-2 hover:text-white"
                  >
                    ← Back
                  </button>
                  {/* These sites hand back a direct, playable video file
                      URL, so there's nothing to extract or download here —
                      the "Go" link just opens their own search results in a
                      new tab, and the person pastes the clip's real URL into
                      "Paste YouTube URL"'s sibling flow (the generic
                      paste-a-video-URL box) once they've picked one. */}
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      autoFocus
                      value={siteQuery}
                      onChange={(e) => setSiteQuery(e.target.value)}
                      placeholder="search footage, e.g. “city traffic at night”"
                      className="w-full rounded-lg border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-[11px] text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
                    />
                    <a
                      href={
                        siteQuery.trim()
                          ? site.searchUrl(siteQuery.trim())
                          : undefined
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-disabled={!siteQuery.trim()}
                      onClick={(e) => {
                        if (!siteQuery.trim()) {
                          e.preventDefault();
                          return;
                        }
                        setSiteVisited(true);
                      }}
                      className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
                        siteQuery.trim()
                          ? "bg-accent-500 text-accent-ink hover:bg-accent-400"
                          : "cursor-not-allowed bg-ink-700 text-ink-400"
                      }`}
                    >
                      Go ↗
                    </a>
                  </div>
                  <p className="text-[10px] text-ink-500">
                    Opens {site.label} in a new tab — find a clip there and
                    use its own Download button to save the file.
                  </p>

                  {/* Only appears once they've actually clicked Go and been
                      sent to the site. Pexels and Pixabay don't expose a
                      copyable direct file link anywhere in their normal UI —
                      only an HTML page URL, which this app can't play — so
                      "download it, then upload the file" is the one path
                      that's actually reliable, rather than a paste-a-link
                      field that would silently fail for most people. */}
                  {siteVisited && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="rounded-lg border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-[11px] font-medium text-white hover:border-accent-500"
                    >
                      Downloaded it? Upload the file →
                    </button>
                  )}
                </div>
              ),
          )}
        </div>
      )}

      {/* --- Source summary + model picker -------------------------------- */}
      {meta && model && stage !== "empty" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-650 bg-ink-850 px-3 py-2.5 text-[11px] text-ink-400">
            <span className="truncate text-ink-200">{meta.name}</span>
            <span>{meta.durationSeconds.toFixed(1)}s</span>
            <span>
              {meta.width}×{meta.height}
            </span>
            <span>{fmtBytes(meta.sizeBytes)}</span>
            <button
              type="button"
              onClick={() => {
                setStage("empty");
                setSourceFile(null);
                setSourceUrl("");
                setMeta(null);
                setClips([]);
                setIncluded({});
                backToMediaButtons();
              }}
              className="ml-auto text-accent-400 underline underline-offset-2 hover:text-white"
            >
              Replace video
            </button>
          </div>

          <div>
            <label className="mb-2 block text-[10px] font-medium uppercase tracking-[0.09em] text-accent-400">
              Model
            </label>
            <div className="flex gap-2">
              {REFERENCE_MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModelId(m.id)}
                  className={`flex-1 rounded-lg border px-3 py-2.5 text-left text-xs transition ${
                    m.id === modelId
                      ? "border-accent-400 bg-accent-500/20 text-white"
                      : "border-ink-650 bg-ink-850 text-ink-200 hover:border-ink-600"
                  }`}
                >
                  <span className="block font-medium">{m.label}</span>
                  <span className="mt-0.5 block text-[10px] text-ink-400">
                    up to {referenceVideoCapSeconds(m)}s video ·{" "}
                    {m.maxReferences} images · {resolutionFor(m, m.qualities[0])}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* --- Dynamic capability panel --------------------------------- */}
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-ink-650 bg-ink-850 p-3 text-[11px] text-ink-300 sm:grid-cols-4">
            <Cap label="Video reference" value={`up to ${capSeconds}s`} />
            <Cap label="Image references" value={`${model.maxReferences}`} />
            <Cap
              label="Output durations"
              value={durationsFor(model, "reference2video").join("/") + "s"}
            />
            <Cap
              label="Quality"
              value={qualitiesFor(model, "reference2video")
                .map((q) => resolutionFor(model, q))
                .join(" / ")}
            />
            <Cap
              label="Audio"
              value={model.supportsAudio ? "Supported" : "Not supported"}
            />
            <Cap label="Aspect ratios" value={model.aspectRatios.join(", ")} />
          </div>

          {/* --- 2. Trim timeline ------------------------------------------ */}
          <TrimTimeline
            src={sourceUrl}
            durationSeconds={meta.durationSeconds}
            start={range.start}
            end={range.end}
            onRangeChange={(start, end) => setRange({ start, end })}
            capSeconds={capSeconds}
            canTakeSnap={clips.length > 0}
            onTakeSnap={handleTakeSnap}
            snapMarkers={activeClipSnapSeconds}
            locked={trimLocked}
          />

          {/* --- Prepare -------------------------------------------------- */}
          <div className="space-y-2.5">
            <ConsentCheckbox />
            <button
              type="button"
              onClick={() => void handlePrepare()}
              disabled={stage === "preparing" || !granted}
              className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-accent-ink shadow-lg shadow-accent-500/20 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400 disabled:shadow-none"
            >
              {stage === "preparing"
                ? `${prepareLabel} ${Math.round(prepareProgress * 100)}%`
                : "Prepare clip(s)"}
            </button>
            <p className="text-center text-[11px] text-ink-400">
              This finds scene cuts inside your selection, trims each one
              into its own reference clip, right here in the browser — no
              file leaves your device until each clip is uploaded. The first
              clip may take a little longer while the trimming engine itself
              downloads.
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* --- Snaps ------------------------------------------------------- */}
      {/* Its own section, separate from the "Clip ready" tiles below — a
          snap isn't a scene, it's an extra still pulled from whichever clip
          was prepared most recently (activeClip). Whatever gets edited on
          one still folds onto that clip's own prompt/image references when
          saved (saveSnapPrompt), it's just not nested inside that clip's
          tile visually. */}
      {activeClip && activeClip.snaps.length > 0 && (
        <div className="space-y-2 rounded-xl border border-accent-500/30 bg-accent-500/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">📍 Snaps</h2>
          <p className="text-[11px] text-ink-400">
            Extra frames grabbed from the trim timeline above. Tap one to
            select objects on it — whatever you save there is added onto the
            clip&apos;s own image references below.
          </p>
          <div className="flex flex-wrap gap-2">
            {activeClip.snaps.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() =>
                  setSelectorSnap({ clipId: activeClip.job.id, snapId: s.id })
                }
                title={
                  s.elements.some((el) => el.status === "completed")
                    ? "Snap — selections set, edit →"
                    : "Snap — select objects →"
                }
                className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-ink-650 hover:border-accent-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={s.frameDataUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
                {s.elements.some((el) => el.status === "completed") && (
                  <span className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-accent-400" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* --- Detected scenes + transfer -------------------------------------- */}
      {(stage === "ready" || (stage === "preparing" && clips.length > 0)) &&
        clips.length > 0 && (
          <div className="space-y-3 rounded-xl border border-accent-500/30 bg-accent-500/[0.06] p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">
                {clips.length === 1
                  ? "Clip ready"
                  : `${clips.length} scene${clips.length === 1 ? "" : "s"} found — ${selectedJobs.length} selected`}
              </h2>
              {clips.length > 1 && (
                <div className="flex shrink-0 gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() =>
                      setIncluded(
                        Object.fromEntries(clips.map((c) => [c.job.id, true])),
                      )
                    }
                    className="text-accent-400 underline underline-offset-2 hover:text-white"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setIncluded(
                        Object.fromEntries(clips.map((c) => [c.job.id, false])),
                      )
                    }
                    className="text-accent-400 underline underline-offset-2 hover:text-white"
                  >
                    None
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {clips.map((c, i) => {
                const isIncluded = included[c.job.id] !== false;
                return (
                  <label
                    key={c.job.id}
                    className={`relative block cursor-pointer overflow-hidden rounded-lg border transition ${
                      isIncluded
                        ? "border-accent-400"
                        : "border-ink-650 opacity-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isIncluded}
                      onChange={(e) =>
                        setIncluded((prev) => ({
                          ...prev,
                          [c.job.id]: e.target.checked,
                        }))
                      }
                      className="absolute right-1.5 top-1.5 z-10 h-4 w-4 accent-accent-500"
                    />
                    {c.thumbnail ? (
                      // A fixed-height, letterboxed frame rather than a
                      // forced 16:9 crop — these reference clips are just as
                      // often 9:16, and cropping or stretching a portrait
                      // thumbnail into a landscape box is what made this
                      // tile look warped before. object-contain keeps the
                      // actual frame undistorted; the dark bars fill
                      // whatever's left in the box.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.thumbnail}
                        alt=""
                        className="flex h-32 w-full items-center justify-center bg-ink-900 object-contain"
                      />
                    ) : (
                      <div className="flex h-32 w-full items-center justify-center bg-ink-900 text-[10px] text-ink-500">
                        No preview
                      </div>
                    )}
                    <div className="flex items-center justify-between bg-ink-850 px-2 py-1 text-[10px] text-ink-300">
                      <span>
                        Scene {i + 1} ·{" "}
                        {c.job.referenceVideoDurationSeconds.toFixed(1)}s
                      </span>
                      <a
                        href={c.job.referenceVideoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-accent-400 underline underline-offset-2 hover:text-white"
                      >
                        ↗
                      </a>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        // Opening the selector isn't about this checkbox —
                        // without this, the click would also toggle include
                        // state, since the whole tile is a <label>.
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectorClipId(c.job.id);
                      }}
                      className="block w-full border-t border-ink-650 bg-ink-900 px-2 py-1 text-center text-[10px] text-accent-400 hover:bg-ink-850 hover:text-white"
                    >
                      {c.job.prompt
                        ? "Selections set — edit →"
                        : "Select objects →"}
                    </button>
                  </label>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => void continueInStudio()}
              disabled={
                stage !== "ready" ||
                selectedJobs.length === 0 ||
                navigatingToStudio
              }
              className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-accent-ink shadow-lg shadow-accent-500/20 transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-ink-400 disabled:shadow-none"
            >
              {navigatingToStudio ? "Opening Studio…" : "Continue in Mic Studio →"}
            </button>
            <p className="text-center text-[11px] text-ink-400">
              Opens Studio with {model?.label} and{" "}
              {selectedJobs.length === 1
                ? "the selected clip"
                : "the first selected clip"}{" "}
              already loaded into Reference mode. Nothing generates and no
              credit is spent until you review it there and press Generate
              yourself.
            </p>
          </div>
        )}

      {/* --- Coming next ----------------------------------------------- */}
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-[11px] leading-relaxed text-ink-400">
        <span className="font-medium text-ink-200">Coming next:</span>{" "}
        real ChatGPT-based prompt optimization per element — each
        element&apos;s instruction is used exactly as typed for now, combined
        into one prompt once you press Done, which you can still edit further
        once you land in Mic Studio.
      </div>

      {selectorClip && meta && (
        <SceneObjectSelector
          sourceUrl={sourceUrl}
          sourceWidth={meta.width}
          sourceHeight={meta.height}
          clipStart={selectorClip.start}
          clipEnd={selectorClip.end}
          elements={selectorClip.elements}
          onElementsChange={(updater) =>
            setClipElements(selectorClip.job.id, updater)
          }
          granted={granted}
          onClose={() => setSelectorClipId(null)}
          onSave={(result) => savePromptForClip(selectorClip.job.id, result)}
        />
      )}

      {selectorSnapRecord && selectorSnapClip && (
        <SceneObjectSelector
          sourceUrl={sourceUrl}
          sourceWidth={selectorSnapRecord.frameWidth}
          sourceHeight={selectorSnapRecord.frameHeight}
          clipStart={selectorSnapClip.start}
          clipEnd={selectorSnapClip.end}
          presetFrameDataUrl={selectorSnapRecord.frameDataUrl}
          elements={selectorSnapRecord.elements}
          onElementsChange={(updater) =>
            setSnapElements(
              selectorSnapClip.job.id,
              selectorSnapRecord.id,
              updater,
            )
          }
          granted={granted}
          onClose={() => setSelectorSnap(null)}
          onSave={(result) =>
            saveSnapPrompt(
              selectorSnapClip.job.id,
              selectorSnapRecord.id,
              result,
            )
          }
        />
      )}
    </div>
  );
}

function Cap({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wide text-ink-500">
        {label}
      </div>
      <div className="mt-0.5 text-ink-100">{value}</div>
    </div>
  );
}
