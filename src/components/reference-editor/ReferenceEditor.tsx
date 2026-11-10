"use client";

import { useCallback, useRef, useState } from "react";
import FlashOnView from "../FlashOnView";
import TrimTimeline from "./TrimTimeline";
import SceneObjectSelector from "./SceneObjectSelector";
import ConsentCheckbox, {
  UploadConsentProvider,
  useUploadConsent,
} from "@/components/UploadConsent";
import { uploadMedia } from "@/lib/upload";
import { downloadFile } from "@/lib/download";
import { extractClip, planScenesFromCuts } from "@/lib/videoClip";
import { detectSceneCuts } from "@/lib/sceneDetect";
import { captureThumbnail, captureThumbnails } from "@/lib/videoThumbnail";
import { loadFfmpeg } from "@/lib/ffmpegLoader";
import {
  writeReferenceTransfer,
  type ReferenceTransferJob,
} from "@/lib/referenceTransfer";
import { truncateToChars } from "@/lib/text";
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
  /** True once this snap's edits have been folded in via saveSnapPrompt. A
   * snap that was only ever taken — never opened in "Select objects" —
   * stays false forever, which is how buildCombinedReferences (below)
   * knows it still needs to upload that snap's raw frameDataUrl and append
   * it as its own reference, rather than assuming every snap already
   * contributed an image. */
  mergedIntoClip: boolean;
  /**
   * This snap's position in the final combined reference sequence —
   * assigned once, the moment its edit is actually saved via
   * saveSnapPrompt (never at take time: taking a snap is provisional,
   * saving it is the deliberate act that fixes its place). Stays null for
   * a snap that's never opened in "Select objects" at all; such a snap
   * still contributes its raw frame (see buildCombinedReferences), it just
   * has no explicit position, so it's placed after everything that does.
   * Kept stable across re-saves of the same snap — editing it again updates
   * its content, not its place in line.
   */
  seq: number | null;
  /** This snap's own saved edit result — kept separate from the parent
   * clip's `job` so saving a DIFFERENT snap, or the clip's own selector,
   * can never silently overwrite it. Empty until mergedIntoClip is true. */
  editedImageUrls: string[];
  editedPrompt: string;
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
  /**
   * What this clip's own beat should say on screen — typed by hand, never
   * invented. Fed to /api/compose-prompt as this clip's "Headline: ..."
   * line in continueInStudio's merged prompt; left blank, that beat's line
   * just has no headline at all rather than the model making one up.
   */
  headline: string;
  /**
   * The clip's OWN "Select objects" edit result — separate from any snap's
   * (see SnapRecord.editedImageUrls/editedPrompt for the matching fields
   * one level down), and separate from `job.referenceImageUrls`/`job.prompt`
   * themselves, which buildCombinedReferences now writes to ONLY once, right
   * before the hand-off to Studio, from this field plus every snap's own
   * saved result — never incrementally as each edit is saved. That's the
   * fix for a real data-loss bug this replaced: the old code wrote straight
   * onto job.referenceImageUrls from whichever editor (the clip's own, or a
   * snap's) was saved most recently, and the clip's own save *replaced* the
   * whole list rather than merging — so saving the clip's own selection
   * after a snap had already merged its images in silently wiped the
   * snap's contribution out. Null until the clip's own selector has been
   * saved at least once. `seq` is assigned once, the first time this is
   * set, and kept stable on every re-save after that — same reasoning as
   * SnapRecord.seq.
   */
  clipEdit: { seq: number; imageUrls: string[]; prompt: string } | null;
}

/**
 * What a snap's own thumbnail should actually show. Previously always
 * `s.frameDataUrl` — the raw captured still, forever, even once that snap
 * had gone through "Select objects" and the person had an AI-edited result
 * sitting right there (e.g. "Add Orange with drone view."). The tile never
 * updated to reflect it, so the thumbnail looked stuck on the original frame
 * no matter how many edits were saved. This now prefers the most recent
 * saved edit result — the last image in `editedImageUrls`, since
 * saveSnapPrompt's `referenceImageUrls` already carries that edit's actual
 * images in order — and only falls back to the raw frame for a snap that's
 * never been merged, or (the buildCombinedReferences fallback case) was
 * saved with no image of its own at all.
 */
function snapPreviewUrl(s: SnapRecord): string {
  if (s.mergedIntoClip && s.editedImageUrls.length > 0) {
    return s.editedImageUrls[s.editedImageUrls.length - 1];
  }
  return s.frameDataUrl;
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
  // Shared across every clip's own "Select objects" save and every snap's
  // own save, regardless of which clip or snap it belongs to — a single
  // increasing counter is what lets buildCombinedReferences recover "the
  // order the user actually committed these edits in" later, since nothing
  // else records that (two saves a minute apart look identical otherwise).
  const editSeq = useRef(0);

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
  // Same idea, one level down: which snaps actually contribute their
  // image(s) to the final hand-off. Keyed by snap id, absence means
  // "included" — same default-on convention as `included` above, so an
  // unchecked box is always something the person actively did, never a
  // silent default.
  const [snapIncluded, setSnapIncluded] = useState<Record<string, boolean>>(
    {},
  );
  // Which single thumbnail (a snap, or a clip's own video) is mid-download —
  // one id at a time is plenty; this only disables that one control while
  // its own fetch-to-blob is in flight (see lib/download.ts).
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function handleThumbnailDownload(
    id: string,
    url: string,
    filename: string,
  ) {
    if (downloadingId) return;
    setDownloadingId(id);
    try {
      await downloadFile(url, filename);
    } finally {
      setDownloadingId(null);
    }
  }
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
            headline: "",
            clipEdit: null,
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
              // Stored on its own field, not written onto c.job — see
              // PreparedClip.clipEdit's doc comment for why a direct write
              // here used to silently erase whatever a snap had already
              // contributed. `seq` is kept from a prior save so re-editing
              // the same clip updates its content without moving its place
              // in the final sequence.
              clipEdit: {
                seq: c.clipEdit?.seq ?? (editSeq.current += 1),
                imageUrls: result.referenceImageUrls,
                prompt: result.prompt,
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

  /** Updates one clip's own on-screen headline text — see PreparedClip's
   * `headline` doc comment. */
  function setClipHeadline(clipId: string, headline: string) {
    setClips((prev) =>
      prev.map((c) => (c.job.id === clipId ? { ...c, headline } : c)),
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
        seq: null,
        editedImageUrls: [],
        editedPrompt: "",
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
   * here stores its Dataset 2 on the snap itself (editedImageUrls/
   * editedPrompt), NOT on the parent clip's job. `seq` is kept from a prior
   * save so re-editing the same snap updates its content without moving
   * its place in the final sequence (see buildCombinedReferences, which is
   * what actually reads this into the hand-off to Studio).
   */
  function saveSnapPrompt(
    clipId: string,
    snapId: string,
    result: { prompt: string; referenceImageUrls: string[] },
  ) {
    setClips((prev) =>
      prev.map((c) => {
        if (c.job.id !== clipId) return c;
        return {
          ...c,
          snaps: c.snaps.map((s) =>
            s.id === snapId
              ? {
                  ...s,
                  mergedIntoClip: true,
                  seq: s.seq ?? (editSeq.current += 1),
                  editedImageUrls: result.referenceImageUrls,
                  editedPrompt: result.prompt,
                }
              : s,
          ),
        };
      }),
    );
    setSelectorSnap(null);
  }

  /**
   * Builds one clip's final combined reference list and prompt text, right
   * before the hand-off to Studio — replacing the old approach of writing
   * incrementally onto job.referenceImageUrls from inside savePromptForClip
   * and saveSnapPrompt as each edit was saved. That approach lost data: the
   * clip's own save *replaced* the whole list rather than merging, so
   * saving the clip's own selection after a snap had already merged its
   * images in silently wiped the snap's contribution out (see
   * PreparedClip.clipEdit's doc comment).
   *
   * Order here reflects the order the user actually committed each edit in
   * — the clip's own "Select objects" save and every snap's own save all
   * share one sequence counter (editSeq) — rather than "the clip's video
   * frame first, then every snap" or take-order, either of which would
   * silently reorder a beat the user deliberately edited out of sequence.
   * A snap that was only ever taken, never opened in "Select objects", has
   * no seq at all (saving is what assigns one) — its raw frame still
   * contributes, uploaded fresh here the same way it always did, but since
   * the user never expressed an explicit position for it, it's placed
   * after everything that does have one, in the order it was taken.
   *
   * A snap unchecked via its own "include" checkbox is skipped entirely —
   * see `snapIncluded` above.
   *
   * One more case, previously a real data-loss bug: a snap can be opened in
   * "Select objects", given a typed instruction, and saved (Done) without
   * ever attaching a reference image or pressing Send on the ✨ chat — that
   * instruction alone is enough for buildCombinedPrompt to mark the element
   * "completed" (see promptCombiner.ts), but it then has nothing to put in
   * `attachments`, so the snap's own saveSnapPrompt call lands with an
   * empty `referenceImageUrls` array. Before this fix, a merged snap was
   * trusted to always carry its own image(s) and the "never opened" raw-
   * frame fallback below only ran for snaps that were never merged at all —
   * so this exact snap silently contributed zero images AND skipped the raw
   * frame, vanishing from the hand-off entirely. That's "sometimes it's
   * transferring the images and sometimes not" when the only thing done on
   * a snap was typing text: this now falls through to the same raw-frame
   * upload, just keeping the snap's seq/prompt so it still lands in the
   * place the person saved it.
   */
  async function buildCombinedReferences(
    clip: PreparedClip,
  ): Promise<{ imageUrls: string[]; prompt: string }> {
    type Contribution = { seq: number; imageUrls: string[]; prompt: string };
    const ordered: Contribution[] = [];
    const unordered: Contribution[] = [];

    if (clip.clipEdit) {
      if (clip.clipEdit.imageUrls.length > 0) {
        ordered.push({
          seq: clip.clipEdit.seq,
          imageUrls: clip.clipEdit.imageUrls,
          prompt: clip.clipEdit.prompt,
        });
      } else {
        // Same empty-attachments gap fixed for snaps below, one level up:
        // the clip's own "Select objects" selector was saved with a typed
        // instruction but no attached/generated image, so clipEdit.imageUrls
        // is empty — this clip would otherwise vanish from the hand-off
        // (or, if it's the only included clip, leave Studio with zero
        // images entirely, which is the "sometimes landed without assets"
        // report even after the snap-level fix). Falls back to the clip's
        // own already-captured preview thumbnail, uploaded fresh, the same
        // way an un-merged snap falls back to its raw frame.
        let fallbackUrl: string | null = null;
        if (clip.thumbnail) {
          try {
            const blob = await (await fetch(clip.thumbnail)).blob();
            const file = new File([blob], `${clip.job.id}-clip.jpg`, {
              type: "image/jpeg",
            });
            fallbackUrl = await uploadMedia(file, "image", granted);
          } catch {
            // Best-effort — fall through to a prompt-only contribution
            // below rather than blocking the hand-off.
          }
        }
        ordered.push({
          seq: clip.clipEdit.seq,
          imageUrls: fallbackUrl ? [fallbackUrl] : [],
          prompt: clip.clipEdit.prompt,
        });
      }
    }

    for (const s of clip.snaps) {
      if (snapIncluded[s.id] === false) continue;
      if (s.mergedIntoClip && s.seq != null && s.editedImageUrls.length > 0) {
        ordered.push({
          seq: s.seq,
          imageUrls: s.editedImageUrls,
          prompt: s.editedPrompt,
        });
        continue;
      }
      // Either never opened in "Select objects" at all, or opened and saved
      // with no attached/generated image (see doc comment above) — either
      // way, fall back to uploading its own raw captured frame fresh here
      // (same path a clip's own trimmed video goes through) rather than
      // contributing nothing.
      try {
        const blob = await (await fetch(s.frameDataUrl)).blob();
        const file = new File([blob], `${s.id}.jpg`, { type: "image/jpeg" });
        const url = await uploadMedia(file, "image", granted);
        if (s.mergedIntoClip && s.seq != null) {
          // Saved with a real instruction, just no image of its own — keep
          // its place in the sequence and its prompt text.
          ordered.push({ seq: s.seq, imageUrls: [url], prompt: s.editedPrompt });
        } else {
          unordered.push({ seq: 0, imageUrls: [url], prompt: "" });
        }
      } catch {
        // Best-effort — one snap failing to upload shouldn't block the
        // rest of the hand-off to Studio.
      }
    }

    ordered.sort((a, b) => a.seq - b.seq);
    const all = [...ordered, ...unordered];

    return {
      imageUrls: all.flatMap((c) => c.imageUrls).slice(0, model.maxReferences),
      prompt: all
        .map((c) => c.prompt.trim())
        .filter((t) => t.length > 0)
        .join("\n\n"),
    };
  }

  /**
   * Samples a handful of frames evenly across one clip's own trimmed
   * duration — what composeReferencePrompt reads to describe that video's
   * real cut rhythm and framing, since a chat model can be shown images but
   * not handed a video file. Six is enough to read as "cuts happen roughly
   * this often" without ballooning the request; best-effort, same as every
   * other thumbnail capture in this file — a frame that fails to grab just
   * comes back null and gets filtered out below rather than failing the
   * whole hand-off.
   */
  async function sampleMotionFrames(job: ReferenceTransferJob) {
    const COUNT = 6;
    const duration = Math.max(0, job.referenceVideoDurationSeconds);
    const atSeconds = Array.from(
      { length: COUNT },
      (_, i) => (duration * i) / Math.max(1, COUNT - 1),
    );
    const frames = await captureThumbnails(
      job.referenceVideoUrl,
      atSeconds,
      512,
      512,
    );
    return frames.filter((f): f is string => f !== null);
  }

  /**
   * Combines every included clip — and each of their snaps — into exactly
   * ONE job, instead of one job per clip. Reference → Video only ever
   * attaches a single video, so the first included clip's own video is
   * what carries over; but every included clip's own reference image(s)
   * (whatever that clip's own "Select objects" edit produced, same as a
   * single clip's snaps already fold together) are concatenated in
   * selection order into one combined image-reference list — this is also
   * exactly the "Image 1, Image 2, ..." order composeReferencePrompt is
   * told about below. The result is one generation fed by every scene's
   * edit, in order, rather than N separate generations that only ever show
   * one scene at a time (the old behavior — still available in spirit by
   * just including one clip at a time and pressing Generate between each).
   *
   * The prompt itself is now written by /api/compose-prompt rather than
   * just concatenated from each clip's own typed instruction: it's handed
   * the lead clip's sampled motion frames plus every combined image (each
   * with whatever headline was typed for its clip, see PreparedClip.headline)
   * and asked to write a full Reference → Video prompt in the style this
   * was built from. That call is best-effort — on any failure (no API key
   * configured, a network error, OpenAI refusing the request) this falls
   * straight back to the old plain concatenation, so a broken or
   * unconfigured prompt-writer never blocks getting to Studio at all.
   */
  async function continueInStudio() {
    if (selectedJobs.length === 0 || navigatingToStudio) return;
    setNavigatingToStudio(true);
    setError(null);
    try {
      const includedClips = clips.filter((c) => included[c.job.id] !== false);
      const perClipJobs = await Promise.all(
        includedClips.map(async (c) => {
          const built = await buildCombinedReferences(c);
          return {
            ...c.job,
            referenceImageUrls: built.imageUrls,
            prompt: built.prompt,
          };
        }),
      );

      const [firstJob, ...restJobs] = perClipJobs;
      // restJobs' own videos are deliberately dropped — only one video
      // reference can ever be attached, so the first included clip's video
      // is the one that reaches Studio; the rest contribute images and
      // prompt text only. Named here (rather than left implicit) so a
      // future "which clip's video should lead?" picker has an obvious
      // place to plug in instead of this always silently picking "first".
      void restJobs;

      // One entry per image in the final combined list, in order — the
      // first image contributed by each clip carries that clip's own typed
      // headline (if any); any further images from the same clip (extra
      // elements, extra snaps) carry no headline of their own, since the
      // beat they belong to already got one.
      const beats = perClipJobs.flatMap((j, clipIndex) =>
        j.referenceImageUrls.map((imageUrl, imageIndex) => ({
          imageUrl,
          headline:
            imageIndex === 0
              ? includedClips[clipIndex]?.headline.trim() || null
              : null,
        })),
      );
      const trimmedBeats = beats.slice(0, model.maxReferences);
      const combinedImageUrls = trimmedBeats.map((b) => b.imageUrl);

      const fallbackPrompt = perClipJobs
        .map((j) => j.prompt.trim())
        .filter((t) => t.length > 0)
        .join("\n\n");

      let prompt = fallbackPrompt;
      if (trimmedBeats.length > 0) {
        try {
          const motionFrameDataUrls = await sampleMotionFrames(firstJob);
          const res = await fetch("/api/compose-prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              aspectRatio: firstJob.aspectRatio,
              motionFrameDataUrls,
              beats: trimmedBeats,
              // The model this hand-off is actually loading Studio into —
              // its own field cap is what the composed prompt has to fit,
              // not some other model's. See promptWriter.ts's doc comment:
              // this is the fix for a real, correct prompt that simply ran
              // long (2746 chars against this model's 2000-char field).
              maxChars: model.maxPromptChars,
            }),
          });
          const json = (await res.json().catch(() => null)) as {
            prompt?: string;
          } | null;
          if (res.ok && json?.prompt?.trim()) {
            prompt = json.prompt.trim();
          }
        } catch {
          // Best-effort — fallbackPrompt (already computed above) carries
          // this hand-off the rest of the way; see this function's own doc
          // comment for why a broken prompt-writer must never block
          // reaching Studio.
        }
      }

      // Defensive cap, independent of whether /api/compose-prompt ran at
      // all: the plain-concatenation fallback (every clip/snap's own typed
      // instruction, joined) has no length awareness of its own either, and
      // is exactly what ships when OPENAI_API_KEY isn't configured or the
      // call above failed outright — so it needs the same ceiling applied
      // here rather than trusting either path to have already respected it.
      if (prompt.length > model.maxPromptChars) {
        prompt = truncateToChars(prompt, model.maxPromptChars);
      }

      const mergedJob: ReferenceTransferJob = {
        ...firstJob,
        referenceImageUrls: combinedImageUrls,
        prompt,
      };

      writeReferenceTransfer([mergedJob]);
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
        <FlashOnView>
          <p className="mt-1 text-sm text-ink-400">
            Trim a source clip down to a real reference video, sized to fit
            whichever model you&apos;ll generate with, then send it straight
            into Mic Studio.
          </p>
        </FlashOnView>
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
            <FlashOnView>
              <p className="text-center text-[11px] text-ink-400">
                This finds scene cuts inside your selection, trims each one
                into its own reference clip, right here in the browser — no
                file leaves your device until each clip is uploaded. The
                first clip may take a little longer while the trimming
                engine itself downloads.
              </p>
            </FlashOnView>
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
            clip&apos;s own image references below. Uncheck a snap to leave
            it out of the hand-off entirely.
          </p>
          {/* The order-matters hint — first thing a person sees once a
              second potential contribution (a snap, alongside the clip's
              own "Select objects") exists at all, which is exactly the
              moment picking an edit order starts to matter. Flashes once on
              first view (FlashOnView) since it's easy to skim past
              otherwise, and stays concrete rather than abstract: it names
              the actual mechanism (Image 1, Image 2, ...) instead of just
              saying "order matters". */}
          <FlashOnView>
            <p className="rounded-md border border-accent-500/30 bg-accent-500/[0.08] px-2.5 py-1.5 text-[11px] leading-snug text-accent-400">
              Save order matters: whichever snap or selection you save
              first becomes Image 1 in Mic Studio, the next becomes Image 2,
              and so on — not the order these tiles are laid out in.
            </p>
          </FlashOnView>
          <div className="flex flex-wrap gap-2">
            {activeClip.snaps.map((s) => {
              const isIncluded = snapIncluded[s.id] !== false;
              const preview = snapPreviewUrl(s);
              const downloading = downloadingId === s.id;
              return (
                <div
                  key={s.id}
                  className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border transition ${
                    isIncluded
                      ? "border-ink-650 hover:border-accent-400"
                      : "border-ink-650 opacity-40"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSelectorSnap({
                        clipId: activeClip.job.id,
                        snapId: s.id,
                      })
                    }
                    title={
                      s.elements.some((el) => el.status === "completed")
                        ? "Snap — selections set, edit →"
                        : "Snap — select objects →"
                    }
                    className="absolute inset-0 h-full w-full"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={preview}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    {s.elements.some((el) => el.status === "completed") && (
                      <span className="absolute bottom-1 right-1 h-2 w-2 rounded-full bg-accent-400" />
                    )}
                  </button>
                  <input
                    type="checkbox"
                    checked={isIncluded}
                    title="Include this snap in the hand-off to Mic Studio"
                    onChange={(e) =>
                      setSnapIncluded((prev) => ({
                        ...prev,
                        [s.id]: e.target.checked,
                      }))
                    }
                    className="absolute left-1 top-1 z-10 h-3.5 w-3.5 accent-accent-500"
                  />
                  <button
                    type="button"
                    disabled={downloading}
                    title="Download this snap as an image"
                    aria-label="Download this snap as an image"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleThumbnailDownload(
                        s.id,
                        preview,
                        `${s.id}.jpg`,
                      );
                    }}
                    className="absolute bottom-1 left-1 z-10 flex h-4 w-4 items-center justify-center rounded bg-black/70 text-[10px] text-white hover:bg-black disabled:opacity-60"
                  >
                    {downloading ? "…" : "↓"}
                  </button>
                </div>
              );
            })}
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
                    {c.thumbnail && (
                      <button
                        type="button"
                        disabled={downloadingId === `${c.job.id}-thumb`}
                        title="Download this scene's thumbnail as an image"
                        aria-label="Download this scene's thumbnail as an image"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleThumbnailDownload(
                            `${c.job.id}-thumb`,
                            c.thumbnail!,
                            `scene-${i + 1}.jpg`,
                          );
                        }}
                        className="absolute left-1.5 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-[11px] text-white hover:bg-black disabled:opacity-60"
                      >
                        {downloadingId === `${c.job.id}-thumb` ? "…" : "🖼"}
                      </button>
                    )}
                    <div className="flex items-center justify-between gap-1.5 bg-ink-850 px-2 py-1 text-[10px] text-ink-300">
                      <span className="truncate">
                        Scene {i + 1} ·{" "}
                        {c.job.referenceVideoDurationSeconds.toFixed(1)}s
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <a
                          href={c.job.referenceVideoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open this clip's video"
                          onClick={(e) => e.stopPropagation()}
                          className="text-accent-400 underline underline-offset-2 hover:text-white"
                        >
                          ↗
                        </a>
                        <button
                          type="button"
                          disabled={downloadingId === c.job.id}
                          title="Download this clip's video"
                          aria-label="Download this clip's video"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleThumbnailDownload(
                              c.job.id,
                              c.job.referenceVideoUrl,
                              `scene-${i + 1}.mp4`,
                            );
                          }}
                          className="text-accent-400 hover:text-white disabled:opacity-60"
                        >
                          {downloadingId === c.job.id ? "…" : "↓"}
                        </button>
                      </span>
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
                      {c.clipEdit
                        ? "Selections set — edit →"
                        : "Select objects →"}
                    </button>
                    {/* This beat's on-screen text, if any — fed verbatim
                        into /api/compose-prompt as this clip's own
                        "Headline:" line (see PreparedClip.headline and
                        continueInStudio). Click/focus stopped from
                        bubbling so typing here doesn't also toggle the
                        tile's own include checkbox, since the whole tile
                        is a <label>. */}
                    <input
                      type="text"
                      value={c.headline}
                      onChange={(e) =>
                        setClipHeadline(c.job.id, e.target.value)
                      }
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Headline for this beat (optional)"
                      className="block w-full border-t border-ink-650 bg-ink-900 px-2 py-1 text-[10px] text-ink-200 placeholder:text-ink-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
                    />
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
              Opens Studio with {model?.label} already loaded into Reference
              mode:{" "}
              {selectedJobs.length === 1
                ? "the selected clip's video and its own reference image(s)."
                : `the first selected clip's video, with all ${selectedJobs.length} selected clips' reference images combined in order.`}{" "}
              Nothing generates and no credit is spent until you review it
              there and press Generate yourself.
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
