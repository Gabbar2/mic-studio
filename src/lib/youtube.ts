/**
 * YouTube helpers for the Reference Editor's paste-a-URL field — detecting
 * a YouTube link (so it's never even attempted as a direct video source,
 * since YouTube blocks that regardless of license) and checking a video's
 * license via YouTube's own Data API, so the person gets an accurate
 * "you can/can't legally reuse this" message instead of just a generic
 * playback error.
 *
 * This never downloads or extracts video bytes from YouTube — see the
 * comment on YOUTUBE_API_KEY in the route that calls getVideoLicense for
 * why that boundary matters. It only ever reads the same public metadata
 * (including an upload's license) that YouTube's own UI already shows.
 */

/** Pulls the 11-character video id out of any common YouTube URL shape —
 * watch, youtu.be, Shorts, or embed — or returns null for anything else
 * (including a direct video file URL, which the caller should still try to
 * load the normal way). */
export function extractYouTubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\.|^m\./, "");

  if (host === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return id || null;
  }

  if (host !== "youtube.com") return null;

  if (parsed.pathname === "/watch") {
    return parsed.searchParams.get("v");
  }
  const shorts = parsed.pathname.match(/^\/shorts\/([^/?]+)/);
  if (shorts) return shorts[1]!;
  const embed = parsed.pathname.match(/^\/embed\/([^/?]+)/);
  if (embed) return embed[1]!;

  return null;
}

export type YouTubeLicense = "creativeCommon" | "youtube" | "unknown";

/**
 * Looks up a video's declared license via the official YouTube Data API —
 * server-side only, same reasoning as every other provider key in this app
 * (FAL_KEY, OPENAI_API_KEY): this is the one place YOUTUBE_API_KEY can
 * live, and it's billed against a daily quota even though the cost here is
 * effectively free (one quota unit per lookup, 10,000/day by default).
 *
 * Returns "unknown" for a private, deleted, or otherwise unreadable video
 * rather than throwing — the caller treats "unknown" the same as a
 * standard license: something this app can't confirm is safely reusable.
 */
export async function getVideoLicense(
  videoId: string,
): Promise<YouTubeLicense> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    throw new Error(
      "YOUTUBE_API_KEY is not set. Create one at https://console.cloud.google.com/apis/credentials and add it to this app's environment variables.",
    );
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "status");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", key);

  const res = await fetch(url.toString());
  const json = (await res.json().catch(() => null)) as {
    items?: { status?: { license?: string } }[];
    error?: { message?: string };
  } | null;

  if (!res.ok) {
    throw new Error(
      json?.error?.message ?? `YouTube license lookup failed (${res.status}).`,
    );
  }

  const license = json?.items?.[0]?.status?.license;
  if (license === "creativeCommon") return "creativeCommon";
  if (license === "youtube") return "youtube";
  return "unknown";
}

/** A YouTube search results URL for the given free-text query — used by
 * the "Search Creative Commons on YouTube" button. Deliberately does not
 * try to pre-apply the Creative Commons filter itself: that filter is
 * carried in an undocumented, YouTube-internal `sp=` code that can change
 * without notice, and a button that silently stops filtering one day with
 * no error is worse than one extra click. The query alone is stable and
 * documented. */
export function youtubeSearchUrl(query: string): string {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  return url.toString();
}
