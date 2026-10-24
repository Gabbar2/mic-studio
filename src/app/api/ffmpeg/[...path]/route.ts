/**
 * Same-origin proxy for the three ffmpeg.wasm files the Reference Editor's
 * client-side trimming needs (worker.js, ffmpeg-core.js, ffmpeg-core.wasm).
 *
 * This exists to get rid of cross-origin entirely, not just work around it.
 * Loading these straight from jsdelivr ran into two separate browser
 * restrictions: a Worker can't be *constructed* from a cross-origin script
 * URL at all (no CORS header fixes that — it's a same-origin check on the
 * constructor itself), and wrapping the worker script in a same-origin
 * blob: URL to dodge that then caused the worker to silently never request
 * its own core/wasm files once running — no error on either side, just a
 * permanent hang (confirmed in DevTools: zero network requests for those
 * files ever appeared). Serving all three from this app's own origin avoids
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

const SOURCES: Record<string, string> = {
  "worker.js": `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/worker.js`,
  "core.js": `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`,
  "core.wasm": `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.wasm`,
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const file = path.join("/");
  const upstream = SOURCES[file];

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
