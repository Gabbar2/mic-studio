/**
 * Same-origin proxy for the ffmpeg.wasm files the Reference Editor's
 * client-side trimming needs: worker.js, ffmpeg-core.js, ffmpeg-core.wasm,
 * and — this is the part that isn't obvious up front — every sibling module
 * worker.js itself imports (errors.js, const.js, and whatever else the
 * package's dist/esm build splits out). It is NOT one self-contained file;
 * it's a small tree of ES modules that import each other by relative path,
 * and those relative imports resolve against wherever worker.js is actually
 * served from — this route — not against jsdelivr's own folder. So every
 * sibling file needs the same proxying treatment as worker.js, not just
 * worker.js by name; the generic `*.js` branch below exists for exactly
 * that, rather than listing each filename out by hand (the dependency list
 * isn't published anywhere stable to hand-copy from, and a future ffmpeg.wasm
 * patch version could add or rename one).
 *
 * This exists to get rid of cross-origin entirely, not just work around it.
 * Loading these straight from jsdelivr ran into two separate browser
 * restrictions: a Worker can't be *constructed* from a cross-origin script
 * URL at all (no CORS header fixes that — it's a same-origin check on the
 * constructor itself), and wrapping the worker script in a same-origin
 * blob: URL to dodge that then caused the worker to silently never request
 * its own core/wasm files once running — no error on either side, just a
 * permanent hang (confirmed in DevTools: zero network requests for those
 * files ever appeared). Serving everything from this app's own origin avoids
 * both problems at once — nothing is cross-origin or blob: anymore, so
 * there's no special-case behavior left to trip over.
 *
 * Streams the upstream response straight through (`res.body`) rather than
 * buffering it into memory first — ffmpeg-core.wasm is ~30 MB, too large to
 * safely collect into one in-memory buffer in a serverless function. The
 * Edge runtime below supports streaming a response of that size; the
 * default Node serverless runtime does not handle large buffered responses
 * well, so this route deliberately opts into Edge instead.
 */

export const runtime = "edge";

const FFMPEG_VERSION = "0.12.10";
const CORE_VERSION = "0.12.10";

const FFMPEG_ESM_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
// The ESM core build, not the UMD one. worker.js (above) is itself an ES
// module, so it loads its core via a dynamic `import()` rather than
// `importScripts()` — module-type workers can't call `importScripts` at
// all. `import()`-ing the UMD build (meant for `importScripts`/<script>
// loading, not for `import`) is what produced ffmpeg.wasm's own
// "failed to import ffmpeg-core.js" error here; the ESM build is the one
// actually meant to be loaded this way.
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

export async function GET(
  _req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const file = path.join("/");

  // Reject path traversal / empty segments before building any upstream
  // URL from them — this route forwards whatever filename it's asked for,
  // so it has to be the one checking that itself.
  const safe = path.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");

  let upstream: string | null = null;
  if (safe && file === "core.js") {
    upstream = `${CORE_BASE}/ffmpeg-core.js`;
  } else if (safe && file === "core.wasm") {
    upstream = `${CORE_BASE}/ffmpeg-core.wasm`;
  } else if (safe && /\.js$/.test(file)) {
    // worker.js itself, plus every sibling module it imports by relative
    // path (errors.js, const.js, …) — see the top-of-file comment.
    upstream = `${FFMPEG_ESM_BASE}/${file}`;
  }

  if (!upstream) {
    return new Response("Not found", { status: 404 });
  }

  const res = await fetch(upstream);
  if (!res.ok || !res.body) {
    return new Response(
      "Could not fetch the trimming engine from its source.",
      { status: 502 },
    );
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": file.endsWith(".wasm")
        ? "application/wasm"
        : "text/javascript; charset=utf-8",
      // Pinned version in the URL/upstream, so this response never changes
      // underneath a cached copy — safe to cache hard, at the edge and in
      // the browser, for a full year.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
