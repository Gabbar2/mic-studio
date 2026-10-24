"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import TrimTimeline from "./TrimTimeline";
import ConsentCheckbox, {
  UploadConsentProvider,
  useUploadConsent,
} from "@/components/UploadConsent";
import { uploadMedia } from "@/lib/upload";
import { extractClip, planSegments } from "@/lib/videoClip";
import {
  writeReferenceTransfer,
  type ReferenceTransferJob,
} from "@/lib/referenceTransfer";
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

export default function ReferenceEditor() {
  return (
    <UploadConsentProvider>
      <ReferenceEditorInner />
    </UploadConsentProvider>
  );
}

function ReferenceEditorInner() {
  const router = useRouter();
  const { granted } = useUploadConsent();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // A plain incrementing counter rather than Date.now()/crypto.randomUUID() —
  // both read impure/nondeterministic sources the lint rules for component
  // purity flag even from inside an event handler defined in the component
  // body. A ref mutated only in response to a click is exactly what refs are
  // for.
  const jobSeq = useRef(0);

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
  const [jobs, setJobs] = useState<ReferenceTransferJob[]>([]);

  const model = getModel(modelId) ?? REFERENCE_MODELS[0];
  const capSeconds = model ? referenceVideoCapSeconds(model) : 0;

  const loadSource = useCallback((file: File | null, remoteUrl: string) => {
    setError(null);
    setJobs([]);
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

  async function handlePrepare() {
    if (!model || !meta || !sourceUrl) return;
    if (!granted) {
      setError("Tick the confirmation above first.");
      return;
    }

    setStage("preparing");
    setError(null);

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

      const segments = planSegments(range.start, range.end, capSeconds || Infinity);
      const aspectRatio = guessAspectRatio(meta.width, meta.height);
      const newJobs: ReferenceTransferJob[] = [];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        setPrepareLabel(
          segments.length > 1
            ? `Trimming clip ${i + 1} of ${segments.length}…`
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
            ? `Uploading clip ${i + 1} of ${segments.length}…`
            : "Uploading your clip…",
        );
        jobSeq.current += 1;
        const file = new File(
          [clipBlob],
          `reference-${jobSeq.current}-${i + 1}.mp4`,
          { type: "video/mp4" },
        );
        const url = await uploadMedia(file, "video", granted);

        newJobs.push({
          id: `job-${jobSeq.current}`,
          modelId: model.id,
          referenceVideoUrl: url,
          referenceVideoDurationSeconds: seg.end - seg.start,
          referenceImageUrls: [],
          prompt: "",
          aspectRatio,
        });
      }

      setJobs(newJobs);
      setStage("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare the clip.");
      setStage("loaded");
    }
  }

  function continueInStudio() {
    writeReferenceTransfer(jobs);
    router.push("/studio");
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
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-accent-500 px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-400"
          >
            Choose a video
          </button>
          <p className="text-xs text-ink-400">or drag & drop, or paste</p>
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
          <div className="mt-2 flex w-full max-w-sm items-center gap-2 px-4">
            <input
              ref={urlInputRef}
              type="url"
              placeholder="or paste a public video URL"
              className="w-full rounded-lg border border-ink-650 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-ink-500 focus:border-accent-500"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const url = urlInputRef.current?.value.trim();
                  if (url) loadSource(null, url);
                }
              }}
            />
          </div>
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
                setJobs([]);
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
              This trims and re-encodes your clip right here in the browser —
              no file leaves your device until it&apos;s uploaded as the
              finished reference clip. The first clip may take a little
              longer while the trimming engine itself downloads.
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}

      {/* --- Prepared jobs + transfer -------------------------------------- */}
      {stage === "ready" && jobs.length > 0 && (
        <div className="space-y-3 rounded-xl border border-accent-500/30 bg-accent-500/[0.06] p-4">
          <h2 className="text-sm font-semibold text-white">
            {jobs.length === 1
              ? "Clip ready"
              : `${jobs.length} clips ready — one generation job each`}
          </h2>
          <ul className="space-y-1.5">
            {jobs.map((j, i) => (
              <li
                key={j.id}
                className="flex items-center justify-between rounded-lg border border-ink-650 bg-ink-850 px-3 py-2 text-xs text-ink-200"
              >
                <span>
                  Clip {i + 1} of {jobs.length} —{" "}
                  {j.referenceVideoDurationSeconds.toFixed(1)}s
                </span>
                <a
                  href={j.referenceVideoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-400 underline underline-offset-2 hover:text-white"
                >
                  Preview ↗
                </a>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={continueInStudio}
            className="w-full rounded-xl bg-accent-500 px-4 py-3 text-sm font-semibold text-accent-ink shadow-lg shadow-accent-500/20 transition hover:bg-accent-400"
          >
            Continue in Mic Studio →
          </button>
          <p className="text-center text-[11px] text-ink-400">
            Opens Studio with {model?.label} and {jobs.length === 1 ? "this clip" : "the first clip"}{" "}
            already loaded into Reference mode. Nothing generates and no
            credit is spent until you review it there and press Generate
            yourself.
          </p>
        </div>
      )}

      {/* --- Coming next ----------------------------------------------- */}
      <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4 text-[11px] leading-relaxed text-ink-400">
        <span className="font-medium text-ink-200">Coming next:</span>{" "}
        automatic scene detection, hover-to-select objects/backgrounds with
        real AI segmentation, and ChatGPT-drafted editing prompts per
        element. For now, prepare your trimmed reference clip above and
        write your prompt and attach any reference images once you land in
        Mic Studio.
      </div>
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
