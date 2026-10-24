"use client";

/**
 * Lazy-loads ffmpeg.wasm entirely from a CDN, at runtime, in the browser —
 * deliberately NOT an npm dependency.
 *
 * This app is deployed by pasting individual files into GitHub's web editor,
 * one at a time, with no local npm install and no terminal. Adding a real npm
 * dependency means editing package.json AND regenerating package-lock.json —
 * a large generated file that is effectively impossible to hand-edit
 * correctly through a web UI, and a mismatched lockfile fails the Vercel
 * build outright (`npm ci` refuses to proceed). Loading the library from a
 * CDN as a native browser ES module sidesteps all of that: this file and its
 * caller are the only things that need to exist in the repo.
 *
 * Also deliberately the single-threaded core (`@ffmpeg/core`, not
 * `@ffmpeg/core-mt`) — the multi-threaded core needs the page to be
 * cross-origin isolated (COOP/COEP response headers), and this app already
 * embeds third-party iframes/scripts (Cloudflare Turnstile, the tawk.to chat
 * widget) that cross-origin isolation can break. Single-threaded is slower
 * but needs no header changes anywhere else in the app.
 */

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
// @ffmpeg/ffmpeg spawns a background Worker from this exact script, and
// browsers refuse to construct a Worker from a cross-origin URL at all —
// jsdelivr's permissive CORS headers don't help here, since that's a
// fetch-time allowance and this is a same-origin check on the Worker
// constructor itself. Fetched and turned into a same-origin blob: URL below
// (the only one of the three load() URLs that needs this — see the comment
// by `classWorkerURL` in loadFfmpeg for why the other two stay as plain CDN
// URLs instead).
const WORKER_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/worker.js`;

// Minimal structural type for the pieces of the FFmpeg instance this app
// actually calls — the real class has a much larger surface area, and
// loading it from a CDN string import means TypeScript can't see its real
// declaration file anyway.
export interface FfmpegInstance {
  load(opts: {
    coreURL: string;
    wasmURL: string;
    classWorkerURL: string;
  }): Promise<void>;
  writeFile(name: string, data: Uint8Array): Promise<void>;
  readFile(name: string): Promise<Uint8Array>;
  deleteFile(name: string): Promise<void>;
  exec(args: string[]): Promise<number>;
  on(event: "progress", cb: (e: { progress: number }) => void): void;
  on(event: "log", cb: (e: { message: string }) => void): void;
}

declare global {
  interface Window {
    __micFfmpegCtor?: new () => FfmpegInstance;
  }
}

let loadPromise: Promise<FfmpegInstance> | null = null;

/** Fetches a CDN URL and hands back a same-origin blob: URL for it — ffmpeg's
 * own loader needs this rather than the raw cross-origin URL, since a worker
 * can't be constructed from a cross-origin script URL directly. */
async function toBlobURL(url: string, mimeType: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not fetch ${url} (${res.status})`);
  }
  const buf = await res.arrayBuffer();
  return URL.createObjectURL(new Blob([buf], { type: mimeType }));
}

/** Injects a `<script type="module">` that imports the CDN build and stashes
 * the `FFmpeg` constructor on `window` — the only reliable way to pull in a
 * package Next's bundler has never heard of without it trying (and failing)
 * to resolve the import at build time. */
function injectFfmpegModule(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.__micFfmpegCtor) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/+esm";
      window.__micFfmpegCtor = FFmpeg;
      window.dispatchEvent(new Event("mic-ffmpeg-ctor-ready"));
    `;
    script.onerror = () =>
      reject(new Error("Could not load the video-trimming library."));
    window.addEventListener(
      "mic-ffmpeg-ctor-ready",
      () => resolve(),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

/**
 * Returns a loaded, ready-to-use ffmpeg instance — cached after the first
 * call, so re-trimming or splitting a second clip doesn't re-download the
 * ~30 MB core a second time in the same visit.
 */
export async function loadFfmpeg(
  onProgress?: (ratio: number) => void,
): Promise<FfmpegInstance> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    console.log("[ffmpeg] loading the ES module from jsdelivr…");
    await injectFfmpegModule();
    console.log("[ffmpeg] module loaded, constructing instance…");
    const Ctor = window.__micFfmpegCtor;
    if (!Ctor) {
      throw new Error("Video-trimming library did not load correctly.");
    }
    const ffmpeg = new Ctor();
    if (onProgress) {
      ffmpeg.on("progress", (e) => onProgress(Math.min(1, Math.max(0, e.progress))));
    }
    // ffmpeg's own stderr, line by line, prefixed so it's easy to spot in
    // DevTools — the only way to tell "slow but working" apart from "stuck"
    // from outside, since a long single-threaded encode can sit at 0%
    // progress for a while before the library's own progress parser has
    // enough to report. Harmless in production; nobody but someone with
    // DevTools open ever sees it.
    ffmpeg.on("log", (e) => console.log("[ffmpeg]", e.message));
    console.log("[ffmpeg] fetching the worker script…");
    const classWorkerURL = await toBlobURL(WORKER_URL, "text/javascript");
    // coreURL/wasmURL are deliberately NOT blobbed, unlike the worker script
    // above. They're fetched by the WORKER itself once it starts (not by this
    // page), and a worker can `fetch()` an ordinary cross-origin URL under
    // normal CORS rules just fine — jsdelivr already serves the permissive
    // headers that allows. What a worker can't reliably do is resolve a
    // blob: URL that a *different* global (this page) created; that mismatch
    // is what silently hung load() here on the first attempt, with no error
    // on either side to point at it. Only the Worker constructor itself needs
    // same-origin, which is the one thing classWorkerURL above exists to fix.
    const coreURL = `${CORE_BASE}/ffmpeg-core.js`;
    const wasmURL = `${CORE_BASE}/ffmpeg-core.wasm`;
    console.log("[ffmpeg] calling ffmpeg.load()…");
    await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });
    console.log("[ffmpeg] load() resolved — engine ready.");
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (e) {
    // Don't cache a failed load — a transient network blip on page load
    // shouldn't permanently break trimming for the rest of the session.
    loadPromise = null;
    throw e;
  }
}
