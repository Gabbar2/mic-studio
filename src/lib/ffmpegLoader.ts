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
 * CDN as a native browser ES module sidesteps all of that: this file, its
 * caller, and the small proxy route at `src/app/api/ffmpeg/[...path]/route.ts`
 * are the only things that need to exist in the repo.
 *
 * Also deliberately the single-threaded core (`@ffmpeg/core`, not
 * `@ffmpeg/core-mt`) — the multi-threaded core needs the page to be
 * cross-origin isolated (COOP/COEP response headers), and this app already
 * embeds third-party iframes/scripts (Cloudflare Turnstile, the tawk.to chat
 * widget) that cross-origin isolation can break. Single-threaded is slower
 * but needs no header changes anywhere else in the app.
 *
 * The worker script and the wasm core are loaded through this app's own
 * `/api/ffmpeg/*` proxy route rather than straight from jsdelivr — see that
 * route's own doc comment for why: in short, a Worker can't be constructed
 * from a cross-origin script URL at all, and routing around that with a
 * blob: URL caused the worker to silently never request its own core/wasm
 * files once running. Making everything same-origin avoids both problems at
 * once.
 */

const FFMPEG_VERSION = "0.12.10";

const WORKER_URL = "/api/ffmpeg/worker.js";
const CORE_URL = "/api/ffmpeg/core.js";
const WASM_URL = "/api/ffmpeg/core.wasm";

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

/** Injects a `<script type="module">` that imports the CDN build and stashes
 * the `FFmpeg` constructor on `window` — the only reliable way to pull in a
 * package Next's bundler has never heard of without it trying (and failing)
 * to resolve the import at build time. This one import is a plain ES module
 * import statement in the main page thread, not a Worker construction, so
 * it was never subject to the same-origin restriction that forced the
 * worker/core/wasm files onto this app's own `/api/ffmpeg/*` proxy below —
 * loading it straight from jsdelivr is fine as-is. */
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
    console.log("[ffmpeg] calling ffmpeg.load()…");
    await ffmpeg.load({
      coreURL: CORE_URL,
      wasmURL: WASM_URL,
      classWorkerURL: WORKER_URL,
    });
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
